import { parseAbi, type PublicClient } from 'viem';
import type { Env } from '../../config/env.js';
import { ReorgDetectedError } from '../domain/errors.js';
import type { MonitoredContract, NftTransferRecord } from '../domain/types.js';
import { ERC721_TRANSFER_ABI, ERC1155_ABI } from '../../config/constants.js';
import { getBlockTimestamp, getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { NftLogParser } from './log-parser.js';
import type { RawNftLog } from './log-fetcher.js';
import type { ContractWriteCoordinator } from '../util/contract-write-coordinator.js';
import type { FinalizedPersistService } from '../service/finalized-persist-service.js';
import type { ReorgHandler } from '../service/chain-reorg-coordinator.js';

const erc721Abi = parseAbi(ERC721_TRANSFER_ABI);
const erc1155Abi = parseAbi(ERC1155_ABI);

enum LiveState { 
  STOPPED, 
  WATCHING, 
  RECONNECTING 
}
const RECONNECT_MAX_BACKOFF_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class NftLiveWatcher {
  private readonly parser = new NftLogParser();
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
    private readonly persistService: FinalizedPersistService<NftTransferRecord>,
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
      if (contract.tokenType === 'ERC721') {
        const unwatch = this.wsClient.watchContractEvent({
          address, 
          abi: erc721Abi, 
          eventName: 'Transfer', 
          fromBlock,
          onLogs: (logs) => {
            if (this.paused) return;
            this.writeCoordinator.enqueue(contract.address, () =>
              this.handleLogs(contract, logs as unknown as RawNftLog[]));
          },
          onError: (err) => { 
            logger.error({ err, symbol: contract.symbol }, 'ERC721 WS 出错'); 
            this.scheduleReconnect(contracts); 
          },
        });
        this.unwatchFns.push(unwatch);
      } else {
        const unwatchSingle = this.wsClient.watchContractEvent({
          address, 
          abi: erc1155Abi, 
          eventName: 'TransferSingle', 
          fromBlock,
          onLogs: (logs) => {
            if (this.paused) return;
            this.writeCoordinator.enqueue(contract.address, () =>
              this.handleLogs(contract, logs as unknown as RawNftLog[]));
          },
          onError: (err) => { 
            logger.error({ err, symbol: contract.symbol }, 'ERC1155 WS 出错'); 
            this.scheduleReconnect(contracts); 
          },
        });
        const unwatchBatch = this.wsClient.watchContractEvent({
          address, abi: erc1155Abi, eventName: 'TransferBatch', fromBlock,
          onLogs: (logs) => {
            if (this.paused) return;
            this.writeCoordinator.enqueue(contract.address, () =>
              this.handleLogs(contract, logs as unknown as RawNftLog[]));
          },
          onError: (err) => { 
            logger.error({ err, symbol: contract.symbol }, 'ERC1155 Batch WS 出错'); 
            this.scheduleReconnect(contracts); 
          },
        });
        this.unwatchFns.push(unwatchSingle, unwatchBatch);
      }
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
    this.reconnectPromise = this.runReconnectFlow(contracts).finally(() => { this.reconnectPromise = null; });
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
        logger.error({ err }, 'NFT mini-backfill 失败');
      }
      if (!this.shouldRun) {
        this.state = LiveState.STOPPED;
        return;
      }
      if (this.reconnectAttempt > 1) {
        await sleep(Math.min(RECONNECT_MAX_BACKOFF_MS, 1000 * 2 ** (this.reconnectAttempt - 2)));
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
      this.subscribeAll(contracts, resumeFrom);
    } catch (err) {
      logger.error({ err }, 'NFT WebSocket 重连流程失败');
    }
  }

  private async handleLogs(contract: MonitoredContract, logs: RawNftLog[]): Promise<void> {
    if (this.paused || this.state !== LiveState.WATCHING || logs.length === 0) return;
    const uniqueBlocks = [...new Set(
      logs.map((l) => l.blockNumber).filter((b): b is bigint => b != null),
    )];
    const tsMap = new Map<string, Date | null>();
    for (const bn of uniqueBlocks) {
      tsMap.set(bn.toString(), await getBlockTimestamp(this.wsClient, bn));
    }
    const records = this.parser.parseMany(
      logs,
      contract,
      (bn) => tsMap.get(bn.toString()) ?? null,
    );
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
