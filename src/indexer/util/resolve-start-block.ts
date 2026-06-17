import { logger } from '../../infrastructure/logger/logger.js';
import type { MonitoredContract } from '../domain/types.js';

export interface IndexWindowStartParams {
  startBlock: bigint | null;
  /** 当前安全块高（已扣除 CONFIRMATION_DEPTH） */
  safeLatest: bigint;
  lookbackBlocks: bigint;
  hotPartitionMinBlock: bigint | null;
}

/**
 * 解析索引起始块（无 checkpoint 时），与 resolveStartBlock 首扫逻辑一致。
 * 供索引器与物化 worker 共用，保证 start_block 为 NULL 时从 lookback 下界起算。
 */
export function resolveIndexWindowStart(params: IndexWindowStartParams): bigint {
  const { startBlock, safeLatest, lookbackBlocks, hotPartitionMinBlock } = params;
  const lookbackFloor = safeLatest > lookbackBlocks ? safeLatest - lookbackBlocks : 0n;
  let start = startBlock ?? lookbackFloor;
  if (start < lookbackFloor) start = lookbackFloor;
  if (hotPartitionMinBlock != null && start < hotPartitionMinBlock) {
    start = hotPartitionMinBlock;
  }
  return start;
}

export interface ResolveStartBlockParams {
  contract: MonitoredContract;
  /** 已持久化的 checkpoint；有值时从 checkpoint+1 续扫，不再应用 start_block 钳制 */
  checkpoint: bigint | null;
  /** 当前安全块高（已扣除 CONFIRMATION_DEPTH） */
  safeLatest: bigint;
  /** 相对链头的最大回看块数（INDEXER_START_LOOKBACK_BLOCKS） */
  lookbackBlocks: bigint;
  /**
   * 热层已有分区的最小 block_from（migration 预建下界）。
   * 分区服务只做向上扩展，低于此值的块没有分区会导致 INSERT 失败。
   */
  hotPartitionMinBlock: bigint | null;
}

/**
 * 解析合约索引起始块。
 *
 * 原型约束（见 README「注册监控合约」）：
 * - 不从创世/深层历史全量回填，默认从链头附近扫有限块数；
 * - start_block 过低时会被抬升到 lookback 下界与热层分区下界，避免扫过多块或写入无分区崩溃。
 */
export function resolveStartBlock(params: ResolveStartBlockParams): bigint {
  const { contract, checkpoint, safeLatest, lookbackBlocks, hotPartitionMinBlock } = params;

  // 已有 checkpoint：续扫优先，不受 monitored_contracts.start_block 与钳制规则影响
  if (checkpoint != null) {
    const start = checkpoint + 1n;
    logger.info(
      {
        flow: 'indexer.contract',
        symbol: contract.symbol,
        checkpoint: checkpoint.toString(),
        resolvedStartBlock: start.toString(),
        safeLatest: safeLatest.toString(),
      },
      '起始块解析完成（从 checkpoint 续扫）',
    );
    return start;
  }

  const lookbackFloor = safeLatest > lookbackBlocks ? safeLatest - lookbackBlocks : 0n;
  const start = resolveIndexWindowStart({
    startBlock: contract.startBlock,
    safeLatest,
    lookbackBlocks,
    hotPartitionMinBlock,
  });
  const configured = contract.startBlock ?? lookbackFloor;

  if (start !== configured) {
    logger.warn(
      {
        flow: 'indexer.contract',
        symbol: contract.symbol,
        configuredStartBlock: contract.startBlock?.toString() ?? null,
        resolvedStartBlock: start.toString(),
        lookbackFloor: lookbackFloor.toString(),
        hotPartitionMinBlock: hotPartitionMinBlock?.toString() ?? null,
      },
      'start_block 已钳制：原型仅从链头附近索引，且需落在热层预建分区范围内',
    );
  } else {
    logger.info(
      {
        flow: 'indexer.contract',
        symbol: contract.symbol,
        checkpoint: null,
        resolvedStartBlock: start.toString(),
        safeLatest: safeLatest.toString(),
      },
      '起始块解析完成',
    );
  }

  return start;
}
