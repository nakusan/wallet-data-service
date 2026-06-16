/** 链级 anchor 已就绪后，将合约 checkpoint 推进至指定块高。 */
export async function advanceContractCheckpoint(pool, writeSemaphore, checkpointRepo, chainStateRepo, blockAnchorRepo, contract, indexerType, blockNumber) {
    const releaseSem = await writeSemaphore.acquire();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const hash = await blockAnchorRepo.getHashAt(client, contract.chainId, blockNumber);
        if (hash == null) {
            throw new Error(`missing anchor at block ${blockNumber} for checkpoint advance`);
        }
        await checkpointRepo.set(client, contract.chainId, contract.address, indexerType, blockNumber, hash);
        await chainStateRepo.syncFromContractMin(client, contract.chainId);
        await client.query('COMMIT');
    }
    catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
    finally {
        client.release();
        releaseSem();
    }
}
//# sourceMappingURL=contract-checkpoint-advancer.js.map