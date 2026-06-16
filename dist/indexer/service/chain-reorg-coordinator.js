import { BlockReader } from '../chain/block-reader.js';
import { getSafeBlockNumber } from '../chain/viem-client.js';
import { logger } from '../../infrastructure/logger/logger.js';
import { ReorgRepairExecutor } from './reorg-service.js';
/**
 * 以链为单位协调 reorg：同步停止全部 watcher → 单次修复 → 全部回填 → 同步重启。
 */
export class ChainReorgCoordinator {
    env;
    httpClient;
    chainStateRepo;
    blockAnchorRepo;
    chainAnchorService;
    repairExecutor;
    blockReader;
    modules = new Map();
    ancestorFinder = null;
    handling = false;
    constructor(env, httpClient, chainStateRepo, blockAnchorRepo, chainAnchorService, repairExecutor) {
        this.env = env;
        this.httpClient = httpClient;
        this.chainStateRepo = chainStateRepo;
        this.blockAnchorRepo = blockAnchorRepo;
        this.chainAnchorService = chainAnchorService;
        this.repairExecutor = repairExecutor;
        this.blockReader = new BlockReader(httpClient);
    }
    register(module, ancestorFinder) {
        this.modules.set(module.indexerType, module);
        if (ancestorFinder) {
            this.ancestorFinder = ancestorFinder;
        }
    }
    attachLiveWatcher(indexerType, watcher) {
        const module = this.modules.get(indexerType);
        if (module) {
            module.liveWatcher = watcher;
        }
    }
    onReorgDetected(error) {
        queueMicrotask(() => {
            void this.handleReorg(error.commonAncestor);
        });
    }
    async scanAndRepair() {
        if (this.handling)
            return;
        if (!this.ancestorFinder)
            return;
        await this.chainStateRepo.syncFromContractMinOnPool(this.env.CHAIN_ID);
        const chainState = await this.chainStateRepo.get(this.env.CHAIN_ID);
        const scanHigh = chainState.minIndexedCheckpoint;
        if (scanHigh <= 0n)
            return;
        const ancestor = await this.detectFork(this.env.CHAIN_ID, scanHigh);
        if (ancestor == null)
            return;
        await this.handleReorg(ancestor);
    }
    async detectFork(chainId, highBlock) {
        const depth = BigInt(this.env.REORG_SCAN_DEPTH);
        const from = highBlock - depth >= 0n ? highBlock - depth : 0n;
        for (let n = highBlock; n >= from; n--) {
            const stored = await this.blockAnchorRepo.get(chainId, n);
            if (!stored)
                continue;
            const header = await this.blockReader.getHeader(n);
            if (stored.blockHash.toLowerCase() !== header.hash.toLowerCase()) {
                const commonAncestor = await this.ancestorFinder.findCommonAncestorBelow(chainId, n);
                logger.warn({ forkBlock: n.toString(), commonAncestor: commonAncestor.toString() }, 'reorg_detected');
                return commonAncestor;
            }
        }
        return null;
    }
    async handleReorg(commonAncestor) {
        if (this.handling)
            return;
        this.handling = true;
        const moduleList = [...this.modules.values()];
        try {
            for (const module of moduleList) {
                module.liveWatcher?.stopForReorg();
            }
            await Promise.all(moduleList.map((m) => m.writeCoordinator.drain()));
            await this.repairExecutor.repairChain(moduleList, commonAncestor);
            const safeUpper = await getSafeBlockNumber(this.httpClient, this.env.CONFIRMATION_DEPTH);
            await Promise.all(moduleList.map((m) => this.backfillModule(m, commonAncestor, safeUpper)));
            logger.info({ commonAncestor: commonAncestor.toString() }, 'reorg_backfill_completed');
            await Promise.all(moduleList.map((m) => m.writeCoordinator.drain()));
            const resumeFrom = safeUpper - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) > 0n
                ? safeUpper - BigInt(this.env.BACKFILL_OVERLAP_BLOCKS) : 0n;
            for (const module of moduleList) {
                module.liveWatcher?.restartAfterReorg(resumeFrom);
            }
        }
        finally {
            this.handling = false;
        }
    }
    async backfillModule(module, commonAncestor, safeUpper) {
        const contracts = await module.getContracts();
        const from = commonAncestor + 1n;
        if (from > safeUpper)
            return;
        await this.chainAnchorService.ensureSegmented(this.env.CHAIN_ID, from, safeUpper);
        await Promise.all(contracts.map((contract) => module.backfill.fillSegmented(contract, from, safeUpper)));
    }
}
export function createChainReorgCoordinator(pool, env, httpClient, chainStateRepo, blockAnchorRepo, chainAnchorService, checkpointRepo, writeSemaphore) {
    const repairExecutor = new ReorgRepairExecutor(pool, env, httpClient, checkpointRepo, chainStateRepo, blockAnchorRepo, writeSemaphore);
    return new ChainReorgCoordinator(env, httpClient, chainStateRepo, blockAnchorRepo, chainAnchorService, repairExecutor);
}
//# sourceMappingURL=chain-reorg-coordinator.js.map