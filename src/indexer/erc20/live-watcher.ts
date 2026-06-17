import type { PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { MonitoredContract, TransferRecord } from '../domain/types.js';
import { transferAbi } from './log-fetcher.js';
import { getBlockTimestamp, getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { Erc20LogParser } from './log-parser.js';
import type { ContractWriteCoordinator } from '../util/contract-write-coordinator.js';
import type { FinalizedPersistService } from '../service/finalized-persist-service.js';
import type { ReorgHandler } from '../service/chain-reorg-coordinator.js';

enum LiveState { STOPPED, WATCHING, RECONNECTING }
const RECONNECT_MAX_BACKOFF_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Erc20LiveWatcher {
  private readonly parser = new Erc20LogParser();
  private unwatchFns: Array<() => void> = [];
  private shouldRun = false;
  private state: LiveState = LiveState.STOPPED;
  private paused = false;
  private reconnectPromise: Promise<void> | null = null;
  private reconnectAttempt = 0;
  private contracts: MonitoredContract[] = [];
  private reorgStopped = false;

  constructor(
    private readonly env: Env,
    private readonly wsClient: PublicClient,
    private readonly writeCoordinator: ContractWriteCoordinator,
    private readonly persistService: FinalizedPersistService<TransferRecord>,
    private readonly reorgHandler: ReorgHandler,
    private readonly onMiniBackfill: () => Promise<void>,
  ) {}

  stopForReorg(): void {
    this.reorgStopped = true;
    this.paused = true;
    this.stopWatching();
  }

  restartAfterReorg(fromBlock: bigint): void {
    if (!this.shouldRun) return;
    this.reorgStopped = false;
    this.paused = false;
    this.state = LiveState.WATCHING;
    this.reconnectAttempt = 0;
    this.subscribeAll(this.contracts, fromBlock);
  }

  start(contracts: MonitoredContract[], fromBlock: bigint): void {
    if (this.state === LiveState.WATCHING) return;
    this.contracts = contracts;
    this.shouldRun = true;
    this.state = LiveState.WATCHING;
    this.reconnectAttempt = 0;
    logger.info(
      {
        flow: 'erc20.live',
        fromBlock: fromBlock.toString(),
        contracts: contracts.map((c) => ({ symbol: c.symbol, address: c.address })),
      },
      'ERC20 WebSocket 订阅开始',
    );
    this.subscribeAll(contracts, fromBlock);
  }

  async shutdown(): Promise<void> {
    this.shouldRun = false;
    this.stopWatching();
    this.state = LiveState.STOPPED;
    if (this.reconnectPromise) await this.reconnectPromise.catch(() => {});
    await this.writeCoordinator.drain();
  }

  private subscribeAll(contracts: MonitoredContract[], fromBlock: bigint): void {
    this.unwatchFns = [];
    for (const contract of contracts) {
      const address = contract.address as `0x${string}`;
      const unwatch = this.wsClient.watchContractEvent({
        address,
        abi: transferAbi,
        eventName: 'Transfer',
        fromBlock,
        onLogs: (logs) => {
          if (this.paused) return;
          this.writeCoordinator.enqueue(contract.address, () => this.handleLogs(contract, logs));
        },
        onError: (error) => {
          logger.error({ err: error, symbol: contract.symbol }, 'WebSocket 监听出错');
          this.scheduleReconnect(contracts);
        },
      });
      this.unwatchFns.push(unwatch);
    }
  }

  private stopWatching(): void {
    for (const unwatch of this.unwatchFns) unwatch();
    this.unwatchFns = [];
  }

  private scheduleReconnect(contracts: MonitoredContract[]): void {
    if (!this.shouldRun 
      || this.reorgStopped 
      || this.state === LiveState.RECONNECTING 
      || this.reconnectPromise) return;
    this.reconnectPromise = this.runReconnectFlow(contracts)
    .finally(() => {
      this.reconnectPromise = null;
    });
    void this.reconnectPromise;
  }

  private async runReconnectFlow(contracts: MonitoredContract[]): Promise<void> {
    try {
      if (!this.shouldRun) return;
      this.state = LiveState.RECONNECTING;
      this.reconnectAttempt += 1;
      this.stopWatching();
      await this.writeCoordinator.drain();
      try {
        await this.onMiniBackfill();
      } catch (err) {
        logger.error({ err }, 'mini-backfill 失败');
      }
      if (!this.shouldRun) { 
        this.state = LiveState.STOPPED; 
        return; 
      }
      if (this.reconnectAttempt > 1) {
        const delayMs = Math.min(RECONNECT_MAX_BACKOFF_MS, 1000 * 2 ** (this.reconnectAttempt - 2));
        await sleep(delayMs);
      }
      if (!this.shouldRun) { 
        this.state = LiveState.STOPPED; 
        return; 
      }
      const safeLatest = await getSafeBlockNumber(this.wsClient, this.env.CONFIRMATION_DEPTH);
      const resumeFrom = safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
        ? safeLatest - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;
      this.state = LiveState.WATCHING;
      this.reconnectAttempt = 0;
      logger.info(
        { flow: 'erc20.live', resumeFrom: resumeFrom.toString() },
        'ERC20 WebSocket 重连成功，恢复订阅',
      );
      this.subscribeAll(contracts, resumeFrom);
    } catch (err) {
      logger.error({ err }, 'WebSocket 重连流程失败');
    }
  }

  private async handleLogs(
    contract: MonitoredContract,
    logs: Array<{ args: { from?: string; to?: string; value?: bigint };
      transactionHash: `0x${string}` | null; logIndex: number | null;
      blockNumber: bigint | null; address: `0x${string}`; }>,
  ): Promise<void> {
    if (this.paused || this.state !== LiveState.WATCHING || logs.length === 0) return;
    const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null))];
    const minBlock = uniqueBlocks.length > 0
      ? uniqueBlocks.reduce((min, b) => (b < min ? b : min))
      : null;
    logger.debug(
      {
        flow: 'erc20.live',
        symbol: contract.symbol,
        logs: logs.length,
        blocks: uniqueBlocks.length,
        minBlock: minBlock?.toString() ?? null,
        maxBlock: uniqueBlocks.length > 0
          ? uniqueBlocks.reduce((max, b) => (b > max ? b : max)).toString()
          : null,
      },
      '收到 ERC20 Transfer 日志',
    );
    const timestampMap = new Map<string, Date | null>();
    for (const bn of uniqueBlocks) {
      timestampMap.set(bn.toString(), await getBlockTimestamp(this.wsClient, bn));
    }
    const records = this.parser.parseMany(logs, contract, (bn) => timestampMap.get(bn.toString()) ?? null);
    const maxBlock = logs.reduce((max, log) => {
      if (log.blockNumber != null && log.blockNumber > max) return log.blockNumber;
      return max;
    }, 0n);
    if (maxBlock === 0n) return;
    try {
      await this.persistService.persistBatch(contract, records, maxBlock);
    } catch (error) {
      if (error instanceof ReorgDetectedError) {
        this.reorgHandler.onReorgDetected(error);
        return;
      }
      throw error;
    }
  }
}
