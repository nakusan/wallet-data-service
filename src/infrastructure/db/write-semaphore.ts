type Release = () => void;

/**
 * 进程内写事务并发限流：限制同时处于 acquire…release 之间的写路径数量。
 */
export class WriteSemaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {
    if (max < 1) {
      throw new Error(`WriteSemaphore max must be >= 1, got ${max}`);
    }
  }

  async acquire(): Promise<Release> {
    if (this.active < this.max) {
      this.active++;
      return () => this.releaseOne();
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
    this.active++;
    return () => this.releaseOne();
  }

  private releaseOne(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}
