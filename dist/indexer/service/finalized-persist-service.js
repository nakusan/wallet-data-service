import { ReorgDetectedError } from '../domain/errors.js';
import { BlockReader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
export class FinalizedPersistService {
    pool;
    env;
    httpClient;
    transferRepo;
    checkpointRepo;
    blockAnchorRepo;
    chainStateRepo;
    partitionService;
    indexerType;
    writeSemaphore;
    blockReader;
    constructor(pool, env, httpClient, transferRepo, checkpointRepo, blockAnchorRepo, chainStateRepo, partitionService, indexerType, writeSemaphore) {
        this.pool = pool;
        this.env = env;
        this.httpClient = httpClient;
        this.transferRepo = transferRepo;
        this.checkpointRepo = checkpointRepo;
        this.blockAnchorRepo = blockAnchorRepo;
        this.chainStateRepo = chainStateRepo;
        this.partitionService = partitionService;
        this.indexerType = indexerType;
        this.writeSemaphore = writeSemaphore;
        this.blockReader = new BlockReader(httpClient);
    }
    async persistBatch(contract, records, batchMaxBlock, options = {}) {
        const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
        const effectiveMax = batchMaxBlock > safeUpper ? safeUpper : batchMaxBlock;
        const filtered = records.filter((r) => r.blockNumber <= safeUpper);
        const currentCheckpoint = await this.checkpointRepo.get(contract.chainId, contract.address, this.indexerType);
        await this.partitionService.ensureThrough(effectiveMax);
        const anchorBlocks = this.collectAnchorBlocks(options, filtered, currentCheckpoint, effectiveMax);
        const headerMap = await this.prefetchHeaders(anchorBlocks);
        const releaseSem = await this.writeSemaphore.acquire();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            if (options.forceAdvance) {
                const anchorStart = options.anchorFromBlock ??
                    (currentCheckpoint != null ? currentCheckpoint + 1n : effectiveMax);
                const from = anchorStart > effectiveMax ? effectiveMax : anchorStart;
                await this.writeAnchorsFromPrefetched(client, contract.chainId, from, effectiveMax, headerMap);
            }
            else if (filtered.length > 0) {
                const blocks = [...new Set(filtered.map((r) => r.blockNumber))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                for (const blockNumber of blocks) {
                    const header = headerMap.get(blockNumber.toString());
                    if (!header) {
                        throw new Error(`missing prefetched header for block ${blockNumber}`);
                    }
                    await this.writeAnchorFromPrefetched(client, contract.chainId, blockNumber, header);
                }
            }
            const inserted = filtered.length > 0
                ? await this.transferRepo.batchUpsert(client, filtered)
                : 0;
            const shouldAdvance = this.shouldAdvanceCheckpoint(options, currentCheckpoint, effectiveMax);
            if (shouldAdvance) {
                const hash = await this.blockAnchorRepo.getHashAt(client, contract.chainId, effectiveMax);
                await this.checkpointRepo.set(client, contract.chainId, contract.address, this.indexerType, effectiveMax, hash);
            }
            await this.chainStateRepo.syncFromContractMin(client, contract.chainId);
            await client.query('COMMIT');
            if (records.length > filtered.length) {
                logger.debug({ symbol: contract.symbol, dropped: records.length - filtered.length }, '已丢弃未确认深度的实时日志');
            }
            return inserted;
        }
        catch (error) {
            await client.query('ROLLBACK');
            throw error;
        }
        finally {
            client.release();
            releaseSem();
        }
    }
    collectAnchorBlocks(options, filtered, currentCheckpoint, effectiveMax) {
        if (options.forceAdvance) {
            const anchorStart = options.anchorFromBlock ??
                (currentCheckpoint != null ? currentCheckpoint + 1n : effectiveMax);
            const from = anchorStart > effectiveMax ? effectiveMax : anchorStart;
            if (from > effectiveMax)
                return [];
            const blocks = [];
            for (let n = from; n <= effectiveMax; n++) {
                blocks.push(n);
            }
            return blocks;
        }
        if (filtered.length === 0)
            return [];
        return [...new Set(filtered.map((r) => r.blockNumber))];
    }
    async prefetchHeaders(blockNumbers) {
        const map = new Map();
        for (const n of blockNumbers) {
            map.set(n.toString(), await this.blockReader.getHeader(n));
        }
        return map;
    }
    shouldAdvanceCheckpoint(options, currentCheckpoint, effectiveMax) {
        if (options.forceAdvance)
            return true;
        if (currentCheckpoint == null)
            return effectiveMax >= 0n;
        if (effectiveMax <= currentCheckpoint)
            return false;
        return effectiveMax === currentCheckpoint + 1n;
    }
    async writeAnchorsFromPrefetched(client, chainId, fromBlock, toBlock, headerMap) {
        if (fromBlock > toBlock)
            return;
        for (let n = fromBlock; n <= toBlock; n++) {
            const header = headerMap.get(n.toString());
            if (!header) {
                throw new Error(`missing prefetched header for block ${n}`);
            }
            await this.writeAnchorFromPrefetched(client, chainId, n, header);
        }
    }
    async writeAnchorFromPrefetched(client, chainId, blockNumber, header) {
        const upsert = await this.blockAnchorRepo.upsert(client, chainId, blockNumber, header.hash, header.parentHash);
        if (upsert === 'conflict') {
            const commonAncestor = await this.findCommonAncestorBelow(chainId, blockNumber);
            throw new ReorgDetectedError(blockNumber, commonAncestor);
        }
        if (blockNumber > 0n) {
            const parentStored = await this.blockAnchorRepo.getHashAt(client, chainId, blockNumber - 1n);
            if (parentStored != null && parentStored.toLowerCase() !== header.parentHash.toLowerCase()) {
                const commonAncestor = await this.findCommonAncestorBelow(chainId, blockNumber);
                throw new ReorgDetectedError(blockNumber, commonAncestor);
            }
        }
    }
    async findCommonAncestorBelow(chainId, forkBlock) {
        const scanDepth = BigInt(this.env.REORG_SCAN_DEPTH);
        const from = forkBlock - scanDepth >= 0n ? forkBlock - scanDepth : 0n;
        for (let m = forkBlock - 1n; m >= from; m--) {
            const stored = await this.blockAnchorRepo.get(chainId, m);
            if (!stored)
                continue;
            const header = await this.blockReader.getHeader(m);
            if (stored.blockHash.toLowerCase() === header.hash.toLowerCase())
                return m;
        }
        return forkBlock > 0n ? forkBlock - 1n : 0n;
    }
}
//# sourceMappingURL=finalized-persist-service.js.map