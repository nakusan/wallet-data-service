# wallet-data-service

生产级钱包数据服务，以 [chain-indexer](../chain-indexer) 为基础扩展而来。在完整保留 ERC20 链上索引能力的基础上，新增 NFT（ERC721/ERC1155）和原生币（ETH）索引，并通过 REST API 对外提供钱包资产查询能力。

---

## 功能特性

| 能力 | 说明 |
|------|------|
| ERC20 索引 | 继承 chain-indexer 全部能力，含分区热/温存储、reorg 检测与修复 |
| NFT 索引 | ERC721 Transfer + ERC1155 TransferSingle/TransferBatch，TransferBatch 自动展开 |
| 原生币索引 | 逐块扫描 `eth_getBlockByNumber`，过滤成功交易中 `value > 0` 的转账 |
| 余额物化 | `BalanceSyncWorker` 增量维护 ERC20 余额快照，水位线持久化支持断点续跑 |
| NFT 持有快照 | `NftHoldingSyncWorker` 实时维护 NFT 所有权，ERC1155 delta 增减 |
| REST API | Express 5，含 JWT 鉴权、Scope 控制、滑动窗口限流 |
| Redis 缓存 | 热门地址资产查询缓存，原生币余额 RPC 结果缓存，JWT 黑名单 |

---

## 技术栈

- **Runtime**：Node.js (ESM)，TypeScript 6
- **链交互**：[viem](https://viem.sh) v2
- **数据库**：PostgreSQL（分区表，热/温两层）
- **缓存**：Redis（ioredis）
- **HTTP**：Express 5 + pino-http
- **认证**：JWT（jsonwebtoken）+ API Key（SHA-256 摘要落库）
- **校验**：zod

---

## 系统架构

```
┌──────────────────────────────────────────────────────────────┐
│                   wallet-data-service（单进程）                │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  IndexerApp                                          │    │
│  │  ├── ERC20 Indexer  (BackfillService + LiveWatcher) │    │
│  │  └── NFT Indexer    (BackfillService + LiveWatcher) │    │
│  └─────────────────────────────────────────────────────┘    │
│                        │ 写入                                │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  PostgreSQL（分区表）                                  │    │
│  │  token_transfers / nft_transfers                     │    │
│  └─────────────────────────────────────────────────────┘    │
│                        │ 增量消费                            │
│  ┌────────────────────────────────────────┐                 │
│  │  BalanceSyncWorker  (ERC20 余额物化)    │                 │
│  │  NftHoldingSyncWorker (NFT 持有快照)   │                 │
│  └────────────────────────────────────────┘                 │
│                        │                                    │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Express REST API                                    │    │
│  │  JWT Auth → Redis Cache → Service → PostgreSQL       │    │
│  └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

---

## 数据库表结构

### 索引器表（chain-indexer 继承）

| 表名 | 说明 |
|------|------|
| `monitored_contracts` | 统一合约注册（ERC20 / ERC721 / ERC1155，含 `token_type` 列） |
| `token_transfers` | ERC20 转账热层（`PARTITION BY RANGE (block_number)`） |
| `archive.token_transfers` | ERC20 转账温层（归档后挂载） |
| `indexer_checkpoints` | 每个合约 × indexer_type 的索引进度 |
| `indexer_chain_state` | 链级最终化上界（各合约进度的 MIN） |
| `indexer_block_anchors` | 块哈希锚点，用于 reorg 比对 |
| `archive_manifest` | 热→温分区迁移审计记录 |

### 扩展索引器表（新增）

| 表名 | 说明 |
|------|------|
| `nft_transfers` | NFT 转账热层，`batch_index` 字段区分 TransferBatch 展开行 |
| `archive.nft_transfers` | NFT 转账温层 |

### 钱包服务表（新增）

| 表名 | 说明 |
|------|------|
| `token_balances` | ERC20 余额物化快照，由 BalanceSyncWorker 维护 |
| `nft_holdings` | NFT 持有快照，由 NftHoldingSyncWorker 维护 |
| `balance_sync_state` | 两个 SyncWorker 的水位线持久化（支持进程重启续跑） |
| `api_keys` | API Key 管理，`key_hash = SHA-256(raw_key)`，明文不落库 |
| `request_audit` | API 请求审计日志（按月分区） |

---

## 目录结构

```
wallet-data-service/
├── migrations/                  # 16 个 SQL 文件，顺序执行
├── scripts/
│   └── migrate.ts               # 启动时自动执行未跑的 migration
├── src/
│   ├── config/
│   │   ├── env.ts               # zod 环境变量校验
│   │   └── constants.ts         # ABI、常量
│   ├── indexer/
│   │   ├── domain/              # types.ts、errors.ts
│   │   ├── shared/              # 共用基础设施（repos, reorg, partition...）
│   │   ├── erc20/               # ERC20 索引器（继承 chain-indexer）
│   │   ├── nft/                 # NFT 索引器（ERC721 + ERC1155）
│   │   └── indexer-app.ts       # 统一启动类（协调 ERC20 / NFT 两条流水线）
│   ├── wallet/
│   │   ├── balance-sync-worker.ts      # ERC20 余额增量同步
│   │   ├── nft-holding-sync-worker.ts  # NFT 持有增量同步
│   │   ├── balance-service.ts          # 余额查询（ERC20 + native + NFT）
│   │   ├── tx-history-service.ts       # 交易历史 keyset 分页
│   │   └── holders-service.ts          # Top N 持有者
│   ├── api/
│   │   ├── middleware/          # auth.ts、error-handler.ts
│   │   ├── routes/              # auth、balances、nfts、transactions、holders
│   │   └── app.ts               # Express 应用组装
│   ├── infrastructure/
│   │   ├── db/pool.ts
│   │   ├── cache/redis-client.ts
│   │   └── logger/logger.ts
│   └── index.ts                 # 进程入口
├── .env.example
├── package.json
└── tsconfig.json
```

---

## 快速开始

### 前置要求

- Node.js 20+
- pnpm 10+
- PostgreSQL 15+
- Redis 7+
- Ethereum RPC（HTTP + WebSocket，如 Alchemy / Infura）

### 安装与配置

```bash
# 克隆或进入目录
cd /path/to/wallet-data-service

# 安装依赖
pnpm install

# 复制并编辑环境变量
cp .env.example .env
```

**必填环境变量：**

```dotenv
DATABASE_URL=postgresql://user:pass@localhost:5432/wallet_data
REDIS_URL=redis://localhost:6379
RPC_HTTP_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_WS_URL=wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
JWT_SECRET=your-secret-at-least-32-characters-long
```

### 初始化数据库

```bash
# 执行全部 migration（幂等，已跑过的自动跳过）
pnpm migrate
```

### 注册监控合约

```sql
-- 添加 ERC20 合约
INSERT INTO monitored_contracts (chain_id, token_type, symbol, address, decimals, start_block)
VALUES (1, 'ERC20', 'USDC', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, 21000000);

-- 添加 ERC721 合约
INSERT INTO monitored_contracts (chain_id, token_type, symbol, address, decimals, start_block)
VALUES (1, 'ERC721', 'BAYC', '0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d', NULL, 12000000);

-- 添加 ERC1155 合约
INSERT INTO monitored_contracts (chain_id, token_type, symbol, address, decimals, start_block)
VALUES (1, 'ERC1155', 'OpenSea Shared', '0x495f947276749ce646f68ac8c248420045cb7b5e', NULL, 12000000);
```

### 创建 API Key

```sql
-- SHA-256('sk-your-api-key') 的十六进制值
INSERT INTO api_keys (key_hash, label, scopes, rate_limit)
VALUES (
  encode(sha256('sk-your-api-key'::bytea), 'hex'),
  'wallet-app-prod',
  '{read:balance,read:tx,read:holders}',
  1000
);
```

### 启动服务

```bash
# 开发模式（热重载）
pnpm dev

# 生产模式
pnpm build && pnpm start
```

---

## REST API 文档

所有接口（除 `/v1/auth/token` 和 `/v1/health`）均需携带 JWT。

### 认证

**换取 JWT**

```http
POST /v1/auth/token
Content-Type: application/json

{ "apiKey": "sk-your-api-key" }
```

```json
{ "token": "eyJ...", "ttl": 3600 }
```

后续请求携带：
```
Authorization: Bearer eyJ...
```

---

### 钱包余额

**查询地址持有的所有代币、NFT 及原生币余额**

```http
GET /v1/address/:addr/balances?chainId=1
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `addr` | path | ✅ | 钱包地址（`0x...`，40 hex） |
| `chainId` | query | — | 链 ID，默认 `1`（Ethereum） |

**响应示例：**

```json
{
  "native": {
    "symbol": "ETH",
    "balanceRaw": "1500000000000000000",
    "balance": "1.5"
  },
  "tokens": [
    {
      "contractAddress": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      "symbol": "USDC",
      "decimals": 6,
      "balanceRaw": "100000000",
      "balance": "100.000000"
    }
  ],
  "nfts": [
    {
      "contractAddress": "0xbc4ca0eda7647a8ab7c2061c2e118a18a936f13d",
      "tokenId": "1234",
      "tokenStandard": "ERC721",
      "amount": "1",
      "name": "Bored Ape #1234",
      "imageUrl": "ipfs://...",
      "metadataUri": "ipfs://..."
    }
  ]
}
```

> **缓存**：Redis TTL 30s（ERC20 余额）/ 15s（原生币）/ 60s（NFT）

---

### NFT 列表（分页）

```http
GET /v1/address/:addr/nfts?chainId=1&limit=50&offset=0
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `limit` | query | — | 每页数量，最大 100，默认 50 |
| `offset` | query | — | 偏移量，默认 0 |

---

### 交易历史（游标分页）

```http
GET /v1/address/:addr/transactions?chainId=1&token=0x...&limit=20&cursor=xxx
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `token` | query | — | 合约地址，不传则返回所有代币交易 |
| `limit` | query | — | 每页数量，最大 100，默认 20 |
| `cursor` | query | — | 翻页游标（来自上一页响应的 `nextCursor`） |

**响应示例：**

```json
{
  "data": [
    {
      "txHash": "0xabc...",
      "symbol": "USDC",
      "blockNumber": "21000100",
      "blockTimestamp": "2024-01-01T00:00:00.000Z",
      "fromAddress": "0xAlice...",
      "toAddress": "0xBob...",
      "amount": "100.000000",
      "direction": "in"
    }
  ],
  "nextCursor": "eyJibG9ja051bWJlciI6...",
  "hasMore": true
}
```

> **分页机制**：Keyset Pagination（`block_number, log_index` 组合游标），无 OFFSET，性能恒定，适合大数据量分页。

---

### Top N 持有者

```http
GET /v1/tokens/:contract/holders?chainId=1&limit=20
```

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `contract` | path | ✅ | ERC20 合约地址 |
| `limit` | query | — | 返回数量，最大 100，默认 20 |

**响应示例：**

```json
{
  "data": [
    {
      "holderAddress": "0xWhale...",
      "balanceRaw": "50000000000000",
      "balance": "50000000.000000",
      "rank": 1
    }
  ],
  "total": 20
}
```

> **缓存**：Redis TTL 60s

---

### 健康检查

```http
GET /v1/health
```

```json
{ "status": "ok", "ts": "2026-06-08T09:00:00.000Z" }
```

---

## 环境变量完整说明

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `DATABASE_URL` | ✅ | — | PostgreSQL 连接字符串 |
| `REDIS_URL` | ✅ | — | Redis 连接字符串 |
| `RPC_HTTP_URL` | ✅ | — | 以太坊 HTTP RPC 地址 |
| `RPC_WS_URL` | ✅ | — | 以太坊 WebSocket RPC 地址 |
| `JWT_SECRET` | ✅ | — | JWT 签名密钥（≥32 字符） |
| `CHAIN_ID` | — | `1` | 链 ID |
| `PORT` | — | `3000` | HTTP 监听端口 |
| `JWT_TTL_SECONDS` | — | `3600` | JWT 有效期（秒） |
| `CONFIRMATION_DEPTH` | — | `12` | 最终确认深度（块数） |
| `BACKFILL_MAX_BLOCK_RANGE` | — | `2000` | 单次回填最大块范围 |
| `BACKFILL_OVERLAP_BLOCKS` | — | `2` | 重连后回填重叠块数，防漏块 |
| `HOT_RETAIN_BLOCKS` | — | `648000` | 热层保留块数（约 90 天） |
| `PARTITION_BLOCK_RANGE` | — | `500000` | 分区块范围宽度 |
| `PARTITION_ENSURE_INTERVAL_MS` | — | `300000` | 预创建分区定时间隔（ms） |
| `REORG_SCAN_DEPTH` | — | `128` | reorg 扫描深度（块数） |
| `REORG_SCAN_INTERVAL_MS` | — | `60000` | 定时 reorg 扫描间隔（ms） |
| `BALANCE_SYNC_INTERVAL_MS` | — | `30000` | ERC20 余额同步间隔（ms） |
| `NFT_SYNC_INTERVAL_MS` | — | `30000` | NFT 持有同步间隔（ms） |
| `LOG_LEVEL` | — | `info` | 日志级别（fatal/error/warn/info/debug/trace） |

---

## 关键设计决策

### 余额物化（非实时）

`token_balances` 表由后台 `BalanceSyncWorker` 每 30 秒增量更新，查询接口存在约 30s 的数据滞后。

增量算法核心：以水位线 `[lastSyncedBlock+1, finalized]` 为窗口，对窗口内的转账做双向聚合（`to_address +delta`, `from_address -delta`），通过 `ON CONFLICT DO UPDATE` 原子更新余额。

如需精确实时余额，可在查询时额外叠加 `block_number > last_transfer_block` 的未同步增量（按需权衡性能开销）。

### NFT 持有同步

- **ERC721**：转移时删除旧 owner 行，插入新 owner 行（owner_address 更新语义）
- **ERC1155**：delta 增减，自动清理 `amount ≤ 0` 的行
- Mint（`from = 0x000...000`）和 Burn（`to = 0x000...000`）作为特殊 from/to 处理

### 原生币余额

不做 DB 持久化，查询时通过 `viem.getBalance({ blockTag: 'finalized' })` 实时获取，结果写入 Redis 缓存 15 秒。Redis 缓存 Miss 时直接走 RPC，无单点故障风险。

### 交易历史分页

使用 Keyset Pagination 而非 OFFSET：
- 游标 = `base64url(JSON({ blockNumber, logIndex }))`
- SQL 条件：`(block_number, log_index) < (cursorBlock, cursorLog)`
- 同时查 hot + warm 层（`UNION ALL`），对 PostgreSQL 分区剪枝友好

### JWT 撤销

撤销的 JWT 的 `jti` 写入 Redis Set `jwt:revoked`，TTL = 原 JWT 剩余有效期。每次请求验证前查询此 Set，实现无状态 JWT 的主动注销能力。

---

## Scope 权限说明

| Scope | 允许访问的接口 |
|-------|--------------|
| `read:balance` | `/balances`, `/nfts` |
| `read:tx` | `/transactions` |
| `read:holders` | `/tokens/:contract/holders` |

---

## 生产运维建议

**定期维护 Migration 分区**

`request_audit` 按月分区，每月需提前创建下月分区：
```sql
CREATE TABLE request_audit_2026_09
  PARTITION OF request_audit
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

**监控关键指标**

- `balance_sync_state.last_synced_block` vs `indexer_chain_state.min_indexed_checkpoint`：差值过大说明 SyncWorker 积压
- `indexer_chain_state.finalized_block` vs `latest`：物化 worker 的安全上界，落后过多说明 finalized 推进异常
- `indexer_checkpoints` 各合约进度：落后于 `min_indexed_checkpoint` 说明回填未完成
- Redis 命中率：`INFO stats` 中的 `keyspace_hits / (keyspace_hits + keyspace_misses)`

**热/温层归档**

当热层某个分区的所有块均已被 indexer 扫过（`min_indexed_checkpoint > partition.blockTo`），可通过 PartitionService 将其迁移到 `archive` schema，释放热层空间。

---
