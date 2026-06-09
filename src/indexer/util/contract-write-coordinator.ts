export class ContractWriteCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  enqueue(contractAddress: string, task: () => Promise<void>): void {
    const key = contractAddress.toLowerCase();
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.queues.set(key, next);
  }

  enqueueAndWait(contractAddress: string, task: () => Promise<void>): Promise<void> {
    const key = contractAddress.toLowerCase();
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(task);
    this.queues.set(key, next);
    return next;
  }

  async drain(): Promise<void> {
    const tails = [...this.queues.values()];
    if (tails.length === 0) return;
    await Promise.all(tails.map((t) => t.catch(() => {})));
  }
}
