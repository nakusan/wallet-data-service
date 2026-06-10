import { parseAbi } from 'viem';
import { ReorgDetectedError } from '../domain/errors.js';
import { ERC721_TRANSFER_ABI, ERC1155_ABI } from '../../config/constants.js';
import { getBlockTimestamp, getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { NftLogParser } from './log-parser.js';
const erc721Abi = parseAbi(ERC721_TRANSFER_ABI);
const erc1155Abi = parseAbi(ERC1155_ABI);
var LiveState;
(function (LiveState) {
    LiveState[LiveState["STOPPED"] = 0] = "STOPPED";
    LiveState[LiveState["WATCHING"] = 1] = "WATCHING";
    LiveState[LiveState["RECONNECTING"] = 2] = "RECONNECTING";
})(LiveState || (LiveState = {}));
const RECONNECT_MAX_BACKOFF_MS = 30_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class NftLiveWatcher {
    env;
    wsClient;
    writeCoordinator;
    persistService;
    reorgService;
    onMiniBackfill;
    parser = new NftLogParser();
    unwatchFns = [];
    shouldRun = false;
    state = LiveState.STOPPED;
    paused = false;
    reconnectPromise = null;
    reconnectAttempt = 0;
    constructor(env, wsClient, writeCoordinator, persistService, reorgService, onMiniBackfill) {
        this.env = env;
        this.wsClient = wsClient;
        this.writeCoordinator = writeCoordinator;
        this.persistService = persistService;
        this.reorgService = reorgService;
        this.onMiniBackfill = onMiniBackfill;
    }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    start(contracts, fromBlock) {
        if (this.state === LiveState.WATCHING)
            return;
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
            if (contract.tokenType === 'ERC721') {
                const unwatch = this.wsClient.watchContractEvent({
                    address,
                    abi: erc721Abi,
                    eventName: 'Transfer',
                    fromBlock,
                    onLogs: (logs) => {
                        if (this.paused)
                            return;
                        this.writeCoordinator.enqueue(contract.address, () => this.handleLogs(contract, logs));
                    },
                    onError: (err) => {
                        logger.error({ err, symbol: contract.symbol }, 'ERC721 WS 出错');
                        this.scheduleReconnect(contracts);
                    },
                });
                this.unwatchFns.push(unwatch);
            }
            else {
                const unwatchSingle = this.wsClient.watchContractEvent({
                    address,
                    abi: erc1155Abi,
                    eventName: 'TransferSingle',
                    fromBlock,
                    onLogs: (logs) => {
                        if (this.paused)
                            return;
                        this.writeCoordinator.enqueue(contract.address, () => this.handleLogs(contract, logs));
                    },
                    onError: (err) => {
                        logger.error({ err, symbol: contract.symbol }, 'ERC1155 WS 出错');
                        this.scheduleReconnect(contracts);
                    },
                });
                const unwatchBatch = this.wsClient.watchContractEvent({
                    address, abi: erc1155Abi, eventName: 'TransferBatch', fromBlock,
                    onLogs: (logs) => {
                        if (this.paused)
                            return;
                        this.writeCoordinator.enqueue(contract.address, () => this.handleLogs(contract, logs));
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
    stopWatching() {
        for (const unwatch of this.unwatchFns)
            unwatch();
        this.unwatchFns = [];
    }
    scheduleReconnect(contracts) {
        if (!this.shouldRun
            || this.state === LiveState.RECONNECTING
            || this.reconnectPromise)
            return;
        this.reconnectPromise = this.runReconnectFlow(contracts).finally(() => { this.reconnectPromise = null; });
        void this.reconnectPromise;
    }
    async runReconnectFlow(contracts) {
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
    }
    async handleLogs(contract, logs) {
        if (this.paused || this.state !== LiveState.WATCHING || logs.length === 0)
            return;
        const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber).filter((b) => b != null))];
        const tsMap = new Map();
        for (const bn of uniqueBlocks) {
            tsMap.set(bn.toString(), await getBlockTimestamp(this.wsClient, bn));
        }
        const records = this.parser.parseMany(logs, contract, (bn) => tsMap.get(bn.toString()) ?? null);
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
                await this.reorgService.onReorgDetected(error);
                return;
            }
            throw error;
        }
    }
}
//# sourceMappingURL=live-watcher.js.map