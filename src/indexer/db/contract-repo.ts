import type { Pool } from 'pg';
import type { MonitoredContract, TokenType } from '../domain/types.js';

function rowToContract(row: Record<string, unknown>): MonitoredContract {
  return {
    id: row.id as number,
    chainId: row.chain_id as number,
    tokenType: (row.token_type as string).toUpperCase() as TokenType,
    symbol: row.symbol as string,
    address: (row.address as string).toLowerCase(),
    decimals: row.decimals != null ? (row.decimals as number) : null,
    startBlock: row.start_block != null ? BigInt(row.start_block as string) : null,
    isActive: row.is_active as boolean,
  };
}

export class ContractRepo {
  constructor(private readonly pool: Pool) {}

  async findActive(chainId: number, tokenType?: TokenType): Promise<MonitoredContract[]> {
    const params: unknown[] = [chainId];
    let typeFilter = '';
    if (tokenType) {
      params.push(tokenType);
      typeFilter = ` AND token_type = $${params.length}`;
    }
    const { rows } = await this.pool.query(
      `SELECT id, chain_id, token_type, symbol, address, decimals, start_block, is_active
       FROM monitored_contracts
       WHERE chain_id = $1 AND is_active = true${typeFilter}
       ORDER BY id`,
      params,
    );
    return rows.map(rowToContract);
  }

  async getStartBlock(chainId: number, contractAddress: string): Promise<bigint | null> {
    const { rows } = await this.pool.query(
      `SELECT start_block FROM monitored_contracts
       WHERE chain_id=$1 AND lower(address)=lower($2) AND is_active=true`,
      [chainId, contractAddress],
    );
    const val = rows[0]?.start_block;
    return val != null ? BigInt(val as string) : null;
  }

  /** 活跃 ERC20 监控合约中最小的 start_block（用于未指定 token 的交易历史说明）。 */
  async getMinErc20StartBlock(chainId: number): Promise<bigint | null> {
    const { rows } = await this.pool.query(
      `SELECT MIN(start_block) AS min_block FROM monitored_contracts
       WHERE chain_id=$1 AND is_active=true AND token_type='ERC20' AND start_block IS NOT NULL`,
      [chainId],
    );
    const val = rows[0]?.min_block;
    return val != null ? BigInt(val as string) : null;
  }

  /** start_block 为 NULL 时写入索引起点，供物化层与索引窗口对齐。 */
  async setStartBlockIfNull(
    chainId: number,
    contractAddress: string,
    startBlock: bigint,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE monitored_contracts
       SET start_block = $3
       WHERE chain_id = $1 AND lower(address) = lower($2) AND start_block IS NULL`,
      [chainId, contractAddress, startBlock.toString()],
    );
    return (rowCount ?? 0) > 0;
  }
}
