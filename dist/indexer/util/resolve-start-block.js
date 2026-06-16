import { logger } from '../../infrastructure/logger/logger.js';
/**
 * 解析合约索引起始块。
 *
 * 原型约束（见 README「注册监控合约」）：
 * - 不从创世/深层历史全量回填，默认从链头附近扫有限块数；
 * - start_block 过低时会被抬升到 lookback 下界与热层分区下界，避免扫过多块或写入无分区崩溃。
 */
export function resolveStartBlock(params) {
    const { contract, checkpoint, safeLatest, lookbackBlocks, hotPartitionMinBlock } = params;
    // 已有 checkpoint：续扫优先，不受 monitored_contracts.start_block 与钳制规则影响
    if (checkpoint != null) {
        return checkpoint + 1n;
    }
    const lookbackFloor = safeLatest > lookbackBlocks ? safeLatest - lookbackBlocks : 0n;
    // start_block 为 NULL 时，从链头附近（safeLatest - lookback）开始
    let start = contract.startBlock ?? lookbackFloor;
    const configured = start;
    // 钳制 1：不一次回填超过 lookback 窗口的历史块
    if (start < lookbackFloor) {
        start = lookbackFloor;
    }
    // 钳制 2：不低于热层 migration 预建分区下界（PartitionService 仅向上扩分区）
    if (hotPartitionMinBlock != null && start < hotPartitionMinBlock) {
        start = hotPartitionMinBlock;
    }
    if (start !== configured) {
        logger.warn({
            symbol: contract.symbol,
            configuredStartBlock: contract.startBlock?.toString() ?? null,
            resolvedStartBlock: start.toString(),
            lookbackFloor: lookbackFloor.toString(),
            hotPartitionMinBlock: hotPartitionMinBlock?.toString() ?? null,
        }, 'start_block 已钳制：原型仅从链头附近索引，且需落在热层预建分区范围内');
    }
    return start;
}
//# sourceMappingURL=resolve-start-block.js.map