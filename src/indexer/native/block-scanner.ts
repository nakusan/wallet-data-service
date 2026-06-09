import { formatEther, type PublicClient } from 'viem';
import type { NativeTransferRecord } from '../domain/types.js';
import { withRetry } from '../util/retry.js';
import { logger } from '../../infrastructure/logger/logger.js';

export class NativeBlockScanner {
  constructor(
    private readonly client: PublicClient,
    private readonly chainId: number,
  ) {}

  async scanBlock(blockNumber: bigint): Promise<NativeTransferRecord[]> {
    const block = await withRetry(
      () => this.client.getBlock({ blockNumber, includeTransactions: true }),
      { label: `getBlock ${blockNumber}` },
    );

    if (!block.transactions || block.transactions.length === 0) return [];

    const blockTimestamp = new Date(Number(block.timestamp) * 1000);
    const records: NativeTransferRecord[] = [];

    // 尝试批量获取 receipts（eth_getBlockReceipts，部分节点支持）
    let receiptStatusMap: Map<string, boolean> | null = null;
    try {
      receiptStatusMap = await this.fetchBlockReceipts(blockNumber);
    } catch {
      // 节点不支持，回退到逐笔查询
    }

    for (const tx of block.transactions) {
      if (typeof tx === 'string') continue; // 非 full transaction 时跳过
      if (!tx.to || tx.value === 0n) continue;

      let success = false;
      if (receiptStatusMap) {
        success = receiptStatusMap.get(tx.hash.toLowerCase()) ?? false;
      } else {
        // 逐笔查询 receipt
        try {
          const receipt = await withRetry(
            () => this.client.getTransactionReceipt({ hash: tx.hash }),
            { label: `getReceipt ${tx.hash}` },
          );
          success = receipt.status === 'success';
        } catch (err) {
          logger.warn({ err, txHash: tx.hash }, '获取 receipt 失败，跳过该笔转账');
          continue;
        }
      }

      if (!success) continue;

      records.push({
        chainId: this.chainId,
        txHash: tx.hash,
        blockNumber,
        blockTimestamp,
        txIndex: tx.transactionIndex ?? 0,
        fromAddress: tx.from.toLowerCase(),
        toAddress: tx.to.toLowerCase(),
        valueRaw: tx.value.toString(),
        valueEth: formatEther(tx.value),
      });
    }

    return records;
  }

  private async fetchBlockReceipts(blockNumber: bigint): Promise<Map<string, boolean>> {
    // eth_getBlockReceipts（EIP 标准方法，部分节点支持）
    const receipts = await this.client.request({
      method: 'eth_getBlockReceipts' as never,
      params: [`0x${blockNumber.toString(16)}`] as never,
    }) as Array<{ transactionHash: string; status: string }> | null;

    if (!receipts) throw new Error('eth_getBlockReceipts returned null');

    const map = new Map<string, boolean>();
    for (const r of receipts) {
      map.set(r.transactionHash.toLowerCase(), r.status === '0x1');
    }
    return map;
  }
}
