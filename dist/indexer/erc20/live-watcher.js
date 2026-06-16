import { ReorgDetectedError } from '../domain/errors.js';
import { transferAbi } from './log-fetcher.js';
import { getBlockTimestamp, getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { Erc20LogParser } from './log-parser.js';
var LiveState;
(function (LiveState) {
    LiveState[LiveState["STOPPED"] = 0] = "STOPPED";
    LiveState[LiveState["WATCHING"] = 1] = "WATCHING";
    LiveState[LiveState["RECONNECTING"] = 2] = "RECONNECTING";
})(LiveState || (LiveState = {}));
const RECONNECT_MAX_BACKOFF_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class Erc20LiveWatcher {
    env;
    wsClient;
    writeCoordinator;
    persistService;
    reorgHandler;
    onMiniBackfill;
    parser = new Erc20LogParser();
    unwatchFns = [];
    shouldRun = false;
    state = LiveState.STOPPED;
    paused = false;
    reconnectPromise = null;
    reconnectAttempt = 0;
    contracts = [];
    reorgStopped = false;
    constructor(env, wsClient, writeCoordinator, persistService, reorgHandler, onMiniBackfill) {
        this.env = env;
        this.wsClient = wsClient;
        this.writeCoordinator = writeCoordinator;
        this.persistService = persistService;
        this.reorgHandler = reorgHandler;
        this.onMiniBackfill = onMiniBackfill;
    }
    stopForReorg() {
        this.reorgStopped = true;
        this.paused = true;
        this.stopWatching();
    }
    restartAfterReorg(fromBlock) {
        if (!this.shouldRun)
            return;
        this.reorgStopped = false;
        this.paused = false;
        this.state = LiveState.WATCHING;
        this.reconnectAttempt = 0;
        this.subscribeAll(this.contracts, fromBlock);
    }
    start(contracts, fromBlock) {
        if (this.state === LiveState.WATCHING)
            return;
        this.contracts = contracts;
        this.shouldRun = true;
        this.state = LiveState.WATCHING;
        this.reconnectAttempt = 0;
        this.subscribeAll(contracts, fromBlock);
    }
    async shutdown() {
        this.shouldRun = false;
        this.stopWatching();
        this.state = LiveState.STOPPED;
        if (this.reconnectPromise)
            await this.reconnectPromise.catch(() => { });
        await this.writeCoordinator.drain();
    }
    subscribeAll(contracts, fromBlock) {
        this.unwatchFns = [];
        for (const contract of contracts) {
            const address = contract.address;
            const unwatch = this.wsClient.watchContractEvent({
                address,
                abi: transferAbi,
                eventName: 'Transfer',
                fromBlock,
                onLogs: (logs) => {
                    if (this.paused)
                        return;
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
    stopWatching() {
        for (const unwatch of this.unwatchFns)
            unwatch();
        this.unwatchFns = [];
    }
    scheduleReconnect(contracts) {
        if (!this.shouldRun
            || this.reorgStopped
            || this.state === LiveState.RECONNECTING
            || this.reconnectPromise)
            return;
        this.reconnectPromise = this.runReconnectFlow(contracts)
            .finally(() => {
            this.reconnectPromise = null;
        });
        void this.reconnectPromise;
    }
    async runReconnectFlow(contracts) {
        try {
            if (!this.shouldRun)
                return;
            this.state = LiveState.RECONNECTING;
            this.reconnectAttempt += 1;
            this.stopWatching();
            await this.writeCoordinator.drain();
            try {
                await this.onMiniBackfill();
            }
            catch (err) {
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
            this.subscribeAll(contracts, resumeFrom);
        }
        catch (err) {
            logger.error({ err }, 'WebSocket 重连流程失败');
        }
    }
    async handleLogs(contract, logs) {
        if (this.paused || this.state !== LiveState.WATCHING || logs.length === 0)
            return;
        const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber).filter((b) => b != null))];
        const timestampMap = new Map();
        for (const bn of uniqueBlocks) {
            timestampMap.set(bn.toString(), await getBlockTimestamp(this.wsClient, bn));
        }
        const records = this.parser.parseMany(logs, contract, (bn) => timestampMap.get(bn.toString()) ?? null);
        const maxBlock = logs.reduce((max, log) => {
            if (log.blockNumber != null && log.blockNumber > max)
                return log.blockNumber;
            return max;
        }, 0n);
        if (maxBlock === 0n)
            return;
        try {
            await this.persistService.persistBatch(contract, records, maxBlock);
        }
        catch (error) {
            if (error instanceof ReorgDetectedError) {
                this.reorgHandler.onReorgDetected(error);
                return;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=live-watcher.js.map