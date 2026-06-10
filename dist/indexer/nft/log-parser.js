export class NftLogParser {
    parse(log, contract, blockTimestamp) {
        const base = {
            chainId: contract.chainId,
            contractAddress: contract.address,
            tokenStandard: contract.tokenType,
            blockNumber: log.blockNumber,
            blockTimestamp,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
        };
        if (!log.transactionHash || log.logIndex === null || log.blockNumber === null) {
            return [];
        }
        if (log.eventName === 'Transfer') {
            // ERC721
            const { from, to, tokenId } = log.args;
            if (!from || !to || tokenId === undefined)
                return [];
            return [{
                    ...base,
                    tokenId,
                    batchIndex: 0,
                    fromAddress: from.toLowerCase(),
                    toAddress: to.toLowerCase(),
                    amount: 1n,
                }];
        }
        if (log.eventName === 'TransferSingle') {
            // ERC1155 单条
            const { from, to, id, value } = log.args;
            if (!from || !to || id === undefined || value === undefined)
                return [];
            return [{
                    ...base,
                    tokenId: id,
                    batchIndex: 0,
                    fromAddress: from.toLowerCase(),
                    toAddress: to.toLowerCase(),
                    amount: value,
                }];
        }
        if (log.eventName === 'TransferBatch') {
            // ERC1155 批量 → 展开为多条，batchIndex 保证 PK 唯一
            const { from, to, ids, values } = log.args;
            if (!from || !to || !ids || !values || ids.length !== values.length)
                return [];
            return ids.map((tokenId, i) => ({
                ...base,
                tokenId,
                batchIndex: i,
                fromAddress: from.toLowerCase(),
                toAddress: to.toLowerCase(),
                amount: values[i] ?? 0n,
            }));
        }
        return [];
    }
    parseMany(logs, contract, timestampResolver) {
        const records = [];
        for (const log of logs) {
            const ts = log.blockNumber != null ? timestampResolver(log.blockNumber) : null;
            records.push(...this.parse(log, contract, ts));
        }
        return records;
    }
}
//# sourceMappingURL=log-parser.js.map