/**
 * 进程内写事务并发限流：限制同时处于 acquire…release 之间的写路径数量。
 */
export class WriteSemaphore {
    max;
    active = 0;
    queue = [];
    constructor(max) {
        this.max = max;
        if (max < 1) {
            throw new Error(`WriteSemaphore max must be >= 1, got ${max}`);
        }
    }
    async acquire() {
        if (this.active < this.max) {
            this.active++;
            return () => this.releaseOne();
        }
        await new Promise((resolve) => {
            this.queue.push(resolve);
        });
        this.active++;
        return () => this.releaseOne();
    }
    releaseOne() {
        this.active--;
        const next = this.queue.shift();
        if (next)
            next();
    }
}
//# sourceMappingURL=write-semaphore.js.map