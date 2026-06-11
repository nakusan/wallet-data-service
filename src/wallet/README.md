# wallet 包结构

钱包域：物化同步（写 DB 快照）、API 读路径、链上 RPC 校验。

```
wallet/
├── sync/          # 物化层（后台写入）
├── service/       # API 读路径（Express 注入）
└── chain/         # 链上 RPC 读/校验（方案 3）
```

## sync/ — 物化同步

从 `token_transfers` / `nft_transfers` 增量写入快照；与 Indexer Reorg 联动。

| 文件 | 职责 |
|------|------|
| `balance-sync-worker.ts` | ERC20 `token_balances` 增量聚合 |
| `nft-holding-sync-worker.ts` | NFT `nft_holdings` 逐笔 replay |
| `balance-sync-state-repo.ts` | 合约级物化水位线读写 |
| `materialization-rewinder.ts` | Reorg 时回滚并重算受影响快照 |

入口：`src/index.ts` 启动 Worker；`indexer-app.ts` 注册 Rewinder。

## service/ — API 服务

只读，供 `src/api/routes/*` 调用。

| 文件 | 职责 |
|------|------|
| `balance-service.ts` | 余额/NFT 列表（ERC20/NFT 走 RPC；native 已有 RPC） |
| `holders-service.ts` | Top Holders（读 `token_balances`，索引窗口内） |
| `tx-history-service.ts` | 交易历史 keyset 分页 |
| `indexing-disclaimer.ts` | Top Holders / tx 的 `disclaimer` 文案 |

## chain/ — 链上读

方案 3 的 RPC 层，被 `service/balance-service.ts` 使用。

| 文件 | 职责 |
|------|------|
| `chain-read-abis.ts` | ERC20/721/1155 读合约 ABI |
| `nft-chain-verifier.ts` | NFT 改法 A：DB 候选 + multicall 校验 |

## 数据流

```
Indexer → transfers 表
              ↓
         sync/* Worker → 快照表（Top Holders / NFT 候选）
              ↓
    service/* ← chain/*（用户余额 API 以链为准）
              ↓
           REST API
```
