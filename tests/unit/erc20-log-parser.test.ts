import { describe, it, expect } from 'vitest';
import { Erc20LogParser } from '../../src/indexer/erc20/log-parser.js';
import type { RawTransferLog } from '../../src/indexer/erc20/log-fetcher.js';
import { makeErc20Contract } from './fixtures/contracts.js';

const parser = new Erc20LogParser();
const contract = makeErc20Contract();

function makeLog(overrides: Partial<RawTransferLog> = {}): RawTransferLog {
  return {
    args: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: 1_500_000n,
    },
    transactionHash: '0xabc123',
    logIndex: 0,
    blockNumber: 21_000_100n,
    address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ...overrides,
  };
}

describe('Erc20LogParser', () => {
  it('解析有效 Transfer 日志', () => {
    const ts = new Date('2024-01-01T00:00:00Z');
    const record = parser.parse(makeLog(), contract, ts);

    expect(record).toEqual({
      chainId: 1,
      contractAddress: contract.address,
      symbol: 'USDT',
      txHash: '0xabc123',
      logIndex: 0,
      blockNumber: 21_000_100n,
      blockTimestamp: ts,
      fromAddress: '0x1111111111111111111111111111111111111111',
      toAddress: '0x2222222222222222222222222222222222222222',
      amountRaw: '1500000',
      amount: '1.5',
    });
  });

  it('缺少 blockNumber 时返回 null', () => {
    expect(parser.parse(makeLog({ blockNumber: null }), contract, null)).toBeNull();
  });

  it('缺少 value 时返回 null', () => {
    expect(parser.parse(makeLog({ args: { from: '0xa', to: '0xb' } }), contract, null)).toBeNull();
  });

  it('parseMany 跳过无效日志', () => {
    const logs = [
      makeLog(),
      makeLog({ blockNumber: null }),
    ];
    const records = parser.parseMany(logs, contract, () => null);
    expect(records).toHaveLength(1);
  });

  it('decimals 缺省时按 18 位格式化', () => {
    const noDecimals = makeErc20Contract({ decimals: null });
    const record = parser.parse(makeLog({ args: { from: '0xa', to: '0xb', value: 10n ** 18n } }), noDecimals, null);
    expect(record?.amount).toBe('1');
  });
});
