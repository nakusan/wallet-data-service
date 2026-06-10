-- 移除 native 索引链路：native_transfers 表无任何业务消费者，
-- 原生币余额改由 RPC 实时查询（BalanceService.getNativeBalance）提供。
-- CASCADE 会一并删除其 RANGE 分区子表。
DROP TABLE IF EXISTS native_transfers CASCADE;

-- 清理 native 流水线遗留的 checkpoint 占位行（不再有写入方）。
DELETE FROM indexer_checkpoints WHERE indexer_type = 'native';
