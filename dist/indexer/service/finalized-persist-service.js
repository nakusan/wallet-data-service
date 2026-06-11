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
    blockReader;
    constructor(pool, env, httpClient, transferRepo, checkpointRepo, blockAnchorRepo, chainStateRepo, partitionService, indexerType) {
        this.pool = pool;
        this.env = env;
        this.httpClient = httpClient;
        this.transferRepo = transferRepo;
        this.checkpointRepo = checkpointRepo;
        this.blockAnchorRepo = blockAnchorRepo;
        this.chainStateRepo = chainStateRepo;
        this.partitionService = partitionService;
        this.indexerType = indexerType;
        this.blockReader = new BlockReader(httpClient);
    }
    async persistBatch(contract, records, batchMaxBlock, options = {}) {
        // safeUpper：链上「可安全落库」的上界 = latest - CONFIRMATION_DEPTH。
        // 注意这是确认深度上界，并非链上真正最终化（finalized）的块号。
        // 超过此高度的块仍可能被 reorg，只用于实时展示，不写库。
        const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
        // effectiveMax：本批次实际能推进到的最高块 = min(本批最高块, safeUpper)。
        // 后续分区、checkpoint、anchor 上界都以此为准，不会超过确认深度。
        const effectiveMax = batchMaxBlock > safeUpper ? safeUpper : batchMaxBlock;
        // 只保留已确认深度的记录；未确认的留在内存里等下一批。
        const filtered = records.filter((r) => r.blockNumber <= safeUpper);
        // currentCheckpoint：该合约在本 indexer 下已持久化的最高块（合约级游标）。
        const currentCheckpoint = await this.checkpointRepo.get(contract.chainId, contract.address, this.indexerType);
        await this.partitionService.ensureThrough(effectiveMax);
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            // block anchor：链级游标，记录每个块号的 hash，用于 reorg 检测。
            if (options.forceAdvance) {
                // backfill 场景：区间内可能没有 transfer，但仍需补写 anchor 并推进 checkpoint。
                // anchorStart：从哪块开始补写 anchor（默认 = checkpoint+1，或调用方显式指定）。
                const anchorStart = options.anchorFromBlock ??
                    (currentCheckpoint != null ? currentCheckpoint + 1n : effectiveMax);
                // from：anchor 写入起点，不超过 effectiveMax。
                const from = anchorStart > effectiveMax ? effectiveMax : anchorStart;
                await this.writeAnchorsForRange(client, contract.chainId, from, effectiveMax);
            }
            else if (filtered.length > 0) {
                // live 场景：只为本批实际出现的块写 anchor（有日志才有块）。
                const blocks = [...new Set(filtered.map((r) => r.blockNumber))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                for (const blockNumber of blocks) {
                    await this.writeAnchorForBlock(client, contract.chainId, blockNumber);
                }
            }
            const inserted = filtered.length > 0
                ? await this.transferRepo.batchUpsert(client, filtered)
                : 0;
            // 合约 checkpoint 是否从 currentCheckpoint 推进到 effectiveMax。
            // live 模式要求逐块 +1；backfill 的 forceAdvance 可一次跳过空块区间。
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
        }
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
    async writeAnchorsForRange(client, chainId, fromBlock, toBlock) {
        if (fromBlock > toBlock)
            return;
        for (let n = fromBlock; n <= toBlock; n++) {
            await this.writeAnchorForBlock(client, chainId, n);
        }
    }
    async writeAnchorForBlock(client, chainId, blockNumber) {
        const header = await this.blockReader.getHeader(blockNumber);
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