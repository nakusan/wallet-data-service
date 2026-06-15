import { logger } from '../../infrastructure/logger/logger.js';
const swallowQueueError = (err) => {
    logger.error({ err }, 'ContractWriteCoordinator 队列任务失败');
};
export class ContractWriteCoordinator {
    queues = new Map();
    enqueue(contractAddress, task) {
        const key = contractAddress.toLowerCase();
        const prev = this.queues.get(key) ?? Promise.resolve();
        const next = prev.catch(swallowQueueError).then(task).catch(swallowQueueError);
        this.queues.set(key, next);
    }
    enqueueAndWait(contractAddress, task) {
        const key = contractAddress.toLowerCase();
        const prev = this.queues.get(key) ?? Promise.resolve();
        const next = prev.catch(swallowQueueError).then(task);
        this.queues.set(key, next);
        return next;
    }
    async drain() {
        const tails = [...this.queues.values()];
        if (tails.length === 0)
            return;
        await Promise.all(tails.map((t) => t.catch(swallowQueueError)));
    }
}
//# sourceMappingURL=contract-write-coordinator.js.map