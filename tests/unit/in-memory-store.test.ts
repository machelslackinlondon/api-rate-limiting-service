import { describe, expect, test } from '@jest/globals';

import type { Clock } from '../../src/domain/clock';
import { InMemoryRateLimitStore } from '../../src/stores/in-memory-store';

class FakeClock implements Clock {
  constructor(public value: number) {}

  now(): number {
    return this.value;
  }
}

function createStore(clock: FakeClock): InMemoryRateLimitStore {
  return new InMemoryRateLimitStore({
    clock,
    maxClients: 10,
    maxTotalTimestamps: 100,
    maxTimestampsPerClient: 10,
  });
}

describe('InMemoryRateLimitStore', () => {
  test('allows requests until the limit and then rejects without recording', async () => {
    const clock = new FakeClock(1000);
    const store = createStore(clock);
    const command = { clientId: 'client-1', limit: 2, windowMs: 1000 };

    await expect(store.check(command)).resolves.toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 2000,
      mode: 'memory',
    });
    clock.value = 1100;
    await expect(store.check(command)).resolves.toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 2000,
      mode: 'memory',
    });
    clock.value = 1200;
    await expect(store.check(command)).resolves.toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 2000,
      retryAfterMs: 800,
      mode: 'memory',
    });

    clock.value = 2000;
    await expect(store.check(command)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 2100,
    });
  });

  test('expires timestamps exactly at the cutoff', async () => {
    const clock = new FakeClock(1000);
    const store = createStore(clock);
    const command = { clientId: 'boundary', limit: 1, windowMs: 500 };
    await store.check(command);

    clock.value = 1500;
    await expect(store.check(command)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
      resetAt: 2000,
    });
  });

  test('isolates state for different clients', async () => {
    const store = createStore(new FakeClock(1000));

    await store.check({ clientId: 'client-a', limit: 1, windowMs: 1000 });

    await expect(
      store.check({ clientId: 'client-b', limit: 1, windowMs: 1000 }),
    ).resolves.toMatchObject({ allowed: true });
    expect(store.activeClients()).toBe(2);
  });

  test('accepts multiple requests in the same millisecond', async () => {
    const store = createStore(new FakeClock(1000));
    const command = { clientId: 'same-ms', limit: 2, windowMs: 1000 };

    await expect(store.check(command)).resolves.toMatchObject({ allowed: true });
    await expect(store.check(command)).resolves.toMatchObject({
      allowed: true,
      remaining: 0,
    });
  });

  test('rejects a policy change while timestamps remain active', async () => {
    const store = createStore(new FakeClock(1000));
    await store.check({ clientId: 'locked', limit: 2, windowMs: 1000 });

    await expect(
      store.check({ clientId: 'locked', limit: 3, windowMs: 1000 }),
    ).rejects.toMatchObject({
      code: 'POLICY_CONFLICT',
      activePolicy: { limit: 2, windowMs: 1000 },
    });
  });

  test('accepts a new policy after every active timestamp expires', async () => {
    const clock = new FakeClock(1000);
    const store = createStore(clock);
    await store.check({ clientId: 'replaceable', limit: 2, windowMs: 1000 });

    clock.value = 2000;
    await expect(
      store.check({ clientId: 'replaceable', limit: 3, windowMs: 2000 }),
    ).resolves.toMatchObject({ allowed: true, remaining: 2, resetAt: 4000 });
  });

  test('reports healthy memory state and closes without external resources', async () => {
    const store = createStore(new FakeClock(1000));

    expect(store.health()).toEqual({ status: 'healthy', mode: 'memory' });
    await expect(store.close()).resolves.toBeUndefined();
  });
});
