import { describe, expect, test } from '@jest/globals';

import type { Clock } from '../../src/domain/clock';
import { InMemoryRateLimitStore } from '../../src/stores/in-memory-store';

class FakeClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

function storeWith(
  clock: FakeClock,
  overrides: Partial<{
    maxClients: number;
    maxTotalTimestamps: number;
    maxTimestampsPerClient: number;
  }> = {},
): InMemoryRateLimitStore {
  return new InMemoryRateLimitStore({
    clock,
    maxClients: overrides.maxClients ?? 10,
    maxTotalTimestamps: overrides.maxTotalTimestamps ?? 100,
    maxTimestampsPerClient: overrides.maxTimestampsPerClient ?? 10,
  });
}

describe('in-memory state controls', () => {
  test('rejects an unseen client when active client capacity is full', async () => {
    const clock = new FakeClock(1000);
    const store = storeWith(clock, { maxClients: 1 });
    await store.check({ clientId: 'active', limit: 2, windowMs: 1000 });

    await expect(
      store.check({ clientId: 'new', limit: 2, windowMs: 1000 }),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
    expect(store.activeClients()).toBe(1);
  });

  test('cleans expired clients before rejecting a new client', async () => {
    const clock = new FakeClock(1000);
    const store = storeWith(clock, { maxClients: 1 });
    await store.check({ clientId: 'expired', limit: 1, windowMs: 100 });

    clock.value = 1100;
    await expect(
      store.check({ clientId: 'replacement', limit: 1, windowMs: 100 }),
    ).resolves.toMatchObject({ allowed: true });
    expect(store.activeClients()).toBe(1);
  });

  test('rejects an allocation when the global timestamp budget is active', async () => {
    const store = storeWith(new FakeClock(1000), {
      maxTotalTimestamps: 1,
    });
    await store.check({ clientId: 'first', limit: 2, windowMs: 1000 });

    await expect(
      store.check({ clientId: 'second', limit: 2, windowMs: 1000 }),
    ).rejects.toMatchObject({ code: 'CAPACITY_EXHAUSTED' });
  });

  test('rejects an allocation beyond the per-client timestamp budget', async () => {
    const store = storeWith(new FakeClock(1000), {
      maxTimestampsPerClient: 1,
    });
    const command = { clientId: 'bounded', limit: 2, windowMs: 1000 };
    await store.check(command);

    await expect(store.check(command)).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED',
    });
  });

  test('still returns a policy rejection when no new state is required', async () => {
    const store = storeWith(new FakeClock(1000), {
      maxTotalTimestamps: 1,
      maxTimestampsPerClient: 1,
    });
    const command = { clientId: 'full', limit: 1, windowMs: 1000 };
    await store.check(command);

    await expect(store.check(command)).resolves.toMatchObject({
      allowed: false,
      remaining: 0,
    });
  });

  test('periodic cleanup reports and releases expired state', async () => {
    const clock = new FakeClock(1000);
    const store = storeWith(clock, { maxTotalTimestamps: 1 });
    await store.check({ clientId: 'old', limit: 1, windowMs: 100 });

    clock.value = 1100;
    expect(store.cleanup()).toEqual({ clientsRemoved: 1, timestampsRemoved: 1 });
    expect(store.activeClients()).toBe(0);
    await expect(
      store.check({ clientId: 'new', limit: 1, windowMs: 100 }),
    ).resolves.toMatchObject({ allowed: true });
  });
});
