import { describe, it, expect } from 'vitest';
import { NftLogParser } from '../../src/indexer/nft/log-parser.js';
import type { RawNftLog } from '../../src/indexer/nft/log-fetcher.js';
import { makeNftContract } from './fixtures/contracts.js';

const parser = new NftLogParser();

describe('NftLogParser', () => {
  it('解析 ERC721 Transfer', () => {
    const contract = makeNftContract('ERC721');
    const log: RawNftLog = {
      eventName: 'Transfer',
      args: {
        from: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        to: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        tokenId: 42n,
      },
      transactionHash: '0xdef456',
      logIndex: 1,
      blockNumber: 21_000_100n,
      address: contract.address as `0x${string}`,
    };

    const records = parser.parse(log, contract, null);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      tokenId: 42n,
      batchIndex: 0,
      amount: 1n,
      fromAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      toAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tokenStandard: 'ERC721',
    });
  });

  it('解析 ERC1155 TransferSingle', () => {
    const contract = makeNftContract('ERC1155');
    const log: RawNftLog = {
      eventName: 'TransferSingle',
      args: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        id: 7n,
        value: 5n,
      },
      transactionHash: '0x789',
      logIndex: 2,
      blockNumber: 100n,
      address: contract.address as `0x${string}`,
    };

    const records = parser.parse(log, contract, null);
    expect(records).toEqual([expect.objectContaining({ tokenId: 7n, amount: 5n, batchIndex: 0 })]);
  });

  it('展开 ERC1155 TransferBatch 并设置 batchIndex', () => {
    const contract = makeNftContract('ERC1155');
    const log: RawNftLog = {
      eventName: 'TransferBatch',
      args: {
        from: '0x1111111111111111111111111111111111111111',
        to: '0x2222222222222222222222222222222222222222',
        ids: [1n, 2n],
        values: [10n, 20n],
      },
      transactionHash: '0xbatch',
      logIndex: 0,
      blockNumber: 100n,
      address: contract.address as `0x${string}`,
    };

    const records = parser.parse(log, contract, null);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ tokenId: 1n, batchIndex: 0, amount: 10n });
    expect(records[1]).toMatchObject({ tokenId: 2n, batchIndex: 1, amount: 20n });
  });

  it('TransferBatch ids/values 长度不一致时返回空', () => {
    const contract = makeNftContract('ERC1155');
    const log: RawNftLog = {
      eventName: 'TransferBatch',
      args: {
        from: '0xa',
        to: '0xb',
        ids: [1n],
        values: [1n, 2n],
      },
      transactionHash: '0xbad',
      logIndex: 0,
      blockNumber: 100n,
      address: contract.address as `0x${string}`,
    };
    expect(parser.parse(log, contract, null)).toEqual([]);
  });

  it('缺少 transactionHash 时返回空', () => {
    const contract = makeNftContract('ERC721');
    const log: RawNftLog = {
      eventName: 'Transfer',
      args: { from: '0xa', to: '0xb', tokenId: 1n },
      transactionHash: null,
      logIndex: 0,
      blockNumber: 100n,
      address: contract.address as `0x${string}`,
    };
    expect(parser.parse(log, contract, null)).toEqual([]);
  });
});
