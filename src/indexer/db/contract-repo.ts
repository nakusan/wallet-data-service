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
}
