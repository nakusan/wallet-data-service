import { ZERO_ADDRESS } from '../config/constants.js';
import { logger } from '../infrastructure/logger/logger.js';
import { BalanceSyncStateRepo } from './balance-sync-state-repo.js';
/**
 * ERC20 余额物化的 reorg 回滚器。
 *
 * 触发时机：reorg 修复事务内，已对 token_transfers 完成 markReorgedAfterBlock
 * （commonAncestor 之后的行翻成 'reorged'）之后调用。
 *
 * 策略（正确性优先的「受影响 holder 全量重算」）：
 *  1. 若所有合约物化水位均未越过 commonAncestor，说明这些块尚未被计入快照，直接返回。
 *  2. 否则定位「commonAncestor 之后出现过的所有 (contract, holder)」，
 *     删除其快照后，基于 status='indexed' 且 block_number<=commonAncestor 的全量
 *     （public ∪ archive）重算余额。
 *  3. 将所有越过 commonAncestor 的合约水位回退到 commonAncestor，由 SyncWorker 重放修正后的区间。
 */
export class Erc20BalanceRewinder {
    syncStateRepo = new BalanceSyncStateRepo();
    async rewindForReorg(client, chainId, commonAncestor) {
        const anchor = commonAncestor.toString();
        const needsRewind = await this.syncStateRepo.hasAnyAbove(client, chainId, 'erc20', commonAncestor);
        if (!needsRewind)
            return;
        // 受影响 holder：commonAncestor 之后任何转账涉及的 from/to（public ∪ archive）
        const affectedCte = `
      affected AS (
        SELECT DISTINCT contract_address, holder FROM (
          SELECT contract_address, from_address AS holder FROM token_transfers
            WHERE chain_id=$1 AND block_number>$2
          UNION SELECT contract_address, to_address FROM token_transfers
            WHERE chain_id=$1 AND block_number>$2
          UNION SELECT contract_address, from_address FROM archive.token_transfers
            WHERE chain_id=$1 AND block_number>$2
          UNION SELECT contract_address, to_address FROM archive.token_transfers
            WHERE chain_id=$1 AND block_number>$2
        ) a
      )`;
        await client.query(`WITH ${affectedCte}
       DELETE FROM token_balances tb
       USING affected a
       WHERE tb.chain_id=$1
         AND tb.contract_address=a.contract_address
         AND tb.holder_address=a.holder`, [chainId, anchor]);
        await client.query(`WITH ${affectedCte},
       delta AS (
         SELECT chain_id, contract_address, to_address AS holder, SUM(amount_raw::NUMERIC) AS d
           FROM token_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND to_address<>$3
           GROUP BY chain_id, contract_address, to_address
         UNION ALL
         SELECT chain_id, contract_address, from_address, -SUM(amount_raw::NUMERIC)
           FROM token_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND from_address<>$3
           GROUP BY chain_id, contract_address, from_address
         UNION ALL
         SELECT chain_id, contract_address, to_address, SUM(amount_raw::NUMERIC)
           FROM archive.token_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND to_address<>$3
           GROUP BY chain_id, contract_address, to_address
         UNION ALL
         SELECT chain_id, contract_address, from_address, -SUM(amount_raw::NUMERIC)
           FROM archive.token_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND from_address<>$3
           GROUP BY chain_id, contract_address, from_address
       ),
       net AS (
         SELECT d.chain_id, d.contract_address, d.holder, SUM(d.d) AS net_delta
         FROM delta d
         JOIN affected a
           ON a.contract_address=d.contract_address AND a.holder=d.holder
         GROUP BY d.chain_id, d.contract_address, d.holder
       )
       INSERT INTO token_balances
         (chain_id, contract_address, holder_address,
          symbol, decimals, balance_raw, balance, last_transfer_block)
       SELECT n.chain_id, n.contract_address, n.holder,
              mc.symbol, mc.decimals,
              n.net_delta,
              n.net_delta / POWER(10, mc.decimals),
              $2
       FROM net n
       JOIN monitored_contracts mc
         ON mc.chain_id=n.chain_id AND mc.address=n.contract_address
       WHERE n.net_delta <> 0
       ON CONFLICT (chain_id, contract_address, holder_address) DO UPDATE
         SET balance_raw=EXCLUDED.balance_raw,
             balance=EXCLUDED.balance,
             last_transfer_block=EXCLUDED.last_transfer_block,
             updated_at=NOW()`, [chainId, anchor, ZERO_ADDRESS]);
        await this.syncStateRepo.rewindAllAbove(client, chainId, 'erc20', commonAncestor);
        logger.warn({ commonAncestor: anchor }, 'erc20 余额物化已随 reorg 回滚并重算受影响 holder');
    }
}
/**
 * NFT 持有快照的 reorg 回滚器。
 *
 * 对「commonAncestor 之后出现过的 (contract, token_id)」删除其全部持有行，再基于
 * status='indexed' 且 block_number<=commonAncestor 的全量转账重算所有权。
 * ERC721 与 ERC1155 统一按净额聚合（nft_transfers.amount 对 ERC721 恒为 1），
 * 排除零地址，保留净额>0 的持有者。
 */
export class NftHoldingRewinder {
    syncStateRepo = new BalanceSyncStateRepo();
    async rewindForReorg(client, chainId, commonAncestor) {
        const anchor = commonAncestor.toString();
        const needsRewind = await this.syncStateRepo.hasAnyAbove(client, chainId, 'nft', commonAncestor);
        if (!needsRewind)
            return;
        const affectedCte = `
      affected AS (
        SELECT DISTINCT contract_address, token_id FROM (
          SELECT contract_address, token_id FROM nft_transfers
            WHERE chain_id=$1 AND block_number>$2
          UNION SELECT contract_address, token_id FROM archive.nft_transfers
            WHERE chain_id=$1 AND block_number>$2
        ) a
      )`;
        await client.query(`WITH ${affectedCte}
       DELETE FROM nft_holdings h
       USING affected a
       WHERE h.chain_id=$1
         AND h.contract_address=a.contract_address
         AND h.token_id=a.token_id`, [chainId, anchor]);
        await client.query(`WITH ${affectedCte},
       moves AS (
         SELECT contract_address, token_id, token_standard,
                to_address AS owner, amount::NUMERIC AS d
           FROM nft_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND to_address<>$3
         UNION ALL
         SELECT contract_address, token_id, token_standard,
                from_address, -amount::NUMERIC
           FROM nft_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND from_address<>$3
         UNION ALL
         SELECT contract_address, token_id, token_standard,
                to_address, amount::NUMERIC
           FROM archive.nft_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND to_address<>$3
         UNION ALL
         SELECT contract_address, token_id, token_standard,
                from_address, -amount::NUMERIC
           FROM archive.nft_transfers
           WHERE chain_id=$1 AND status='indexed' AND block_number<=$2 AND from_address<>$3
       ),
       net AS (
         SELECT m.contract_address, m.token_id,
                MIN(m.token_standard) AS token_standard,
                m.owner, SUM(m.d) AS amt
         FROM moves m
         JOIN affected a
           ON a.contract_address=m.contract_address AND a.token_id=m.token_id
         GROUP BY m.contract_address, m.token_id, m.owner
       )
       INSERT INTO nft_holdings
         (chain_id, contract_address, token_id, token_standard,
          owner_address, amount, last_transfer_block)
       SELECT $1, n.contract_address, n.token_id, n.token_standard,
              n.owner, n.amt, $2
       FROM net n
       WHERE n.amt > 0
       ON CONFLICT (chain_id, contract_address, token_id, owner_address) DO UPDATE
         SET amount=EXCLUDED.amount,
             last_transfer_block=EXCLUDED.last_transfer_block,
             updated_at=NOW()`, [chainId, anchor, ZERO_ADDRESS]);
        await this.syncStateRepo.rewindAllAbove(client, chainId, 'nft', commonAncestor);
        logger.warn({ commonAncestor: anchor }, 'nft 持有快照已随 reorg 回滚并重算受影响 token');
    }
}
//# sourceMappingURL=materialization-rewinder.js.map