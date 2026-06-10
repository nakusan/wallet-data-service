import { formatUnits } from 'viem';
export class Erc20LogParser {
    parse(log, contract, blockTimestamp) {
        const { from, to, value } = log.args;
        if (!from || !to || value === undefined || !log.transactionHash ||
            log.logIndex === null || log.blockNumber === null) {
            return null;
        }
        return {
            chainId: contract.chainId,
            contractAddress: contract.address,
            symbol: contract.symbol,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            blockNumber: log.blockNumber,
            blockTimestamp,
            fromAddress: from,
            toAddress: to,
            amountRaw: value.toString(),
            amount: formatUnits(value, contract.decimals ?? 18),
        };
    }
    parseMany(logs, contract, timestampResolver) {
        const records = [];
        for (const log of logs) {
            const ts = log.blockNumber != null ? timestampResolver(log.blockNumber) : null;
            const record = this.parse(log, contract, ts);
            if (record)
                records.push(record);
        }
        return records;
    }
}
//# sourceMappingURL=log-parser.js.map