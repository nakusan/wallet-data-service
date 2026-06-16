import type { BlockReader, BlockHeader } from '../chain/block-reader.js';

/** 限并发拉取区块头；blockNumbers 顺序与返回 map 无关。 */
export async function prefetchBlockHeaders(
  blockReader: BlockReader,
  blockNumbers: bigint[],
  concurrency: number,
): Promise<Map<string, BlockHeader>> {
  if (blockNumbers.length === 0) return new Map();

  const limit = Math.max(1, Math.min(concurrency, blockNumbers.length));
  const map = new Map<string, BlockHeader>();
  let next = 0;

  async function worker(): Promise<void> {
    while (next < blockNumbers.length) {
      const i = next++;
      if (i >= blockNumbers.length) break;
      const n = blockNumbers[i]!;
      map.set(n.toString(), await blockReader.getHeader(n));
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return map;
}
