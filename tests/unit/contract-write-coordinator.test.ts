import { describe, it, expect, vi } from 'vitest';
import { ContractWriteCoordinator } from '../../src/indexer/util/contract-write-coordinator.js';

describe('ContractWriteCoordinator', () => {
  it('同合约地址任务串行执行', async () => {
    const coordinator = new ContractWriteCoordinator();
    const order: number[] = [];

    coordinator.enqueue('0xABC', async () => { order.push(1); });
    coordinator.enqueue('0xabc', async () => { order.push(2); });
    await coordinator.drain();

    expect(order).toEqual([1, 2]);
  });

  it('不同合约地址任务可并行', async () => {
    const coordinator = new ContractWriteCoordinator();
    let aDone = false;

    coordinator.enqueue('0xaaa', async () => {
      await new Promise((r) => setTimeout(r, 20));
      aDone = true;
    });
    coordinator.enqueue('0xbbb', async () => {
      expect(aDone).toBe(false);
    });
    await coordinator.drain();
  });

  it('enqueueAndWait 等待当前任务完成', async () => {
    const coordinator = new ContractWriteCoordinator();
    let value = 0;

    await coordinator.enqueueAndWait('0x1', async () => {
      value = 42;
    });
    expect(value).toBe(42);
  });

  it('单个任务失败不阻塞同队列后续任务', async () => {
    const coordinator = new ContractWriteCoordinator();
    const order: string[] = [];

    coordinator.enqueue('0x1', async () => { throw new Error('fail'); });
    coordinator.enqueue('0x1', async () => { order.push('ok'); });
    await coordinator.drain();

    expect(order).toEqual(['ok']);
  });

  it('drain 空队列立即返回', async () => {
    const coordinator = new ContractWriteCoordinator();
    await expect(coordinator.drain()).resolves.toBeUndefined();
  });

  it('drain 等待所有合约队列尾部完成', async () => {
    const coordinator = new ContractWriteCoordinator();
    const spy = vi.fn();

    coordinator.enqueue('0xa', async () => { spy('a'); });
    coordinator.enqueue('0xb', async () => { spy('b'); });
    await coordinator.drain();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual(['a', 'b']);
  });
});
