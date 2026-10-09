import { describe, expect, test } from '@jest/globals';

import {
  RedisRateLimitStore,
  redisKeyPair,
  type RedisEvalOptions,
  type RedisScriptExecutor,
} from '../../src/stores/redis-store';

class FakeExecutor implements RedisScriptExecutor {
  isReady = true;
  calls: Array<{ script: string; options: RedisEvalOptions }> = [];
  closed = false;

  constructor(private readonly reply: unknown) {}

  async eval(script: string, options: RedisEvalOptions): Promise<unknown> {
    this.calls.push({ script, options });
    return this.reply;
  }

  async quit(): Promise<unknown> {
    this.closed = true;
    return 'OK';
  }

  destroy(): void {
    this.closed = true;
  }
}

describe('redisKeyPair', () => {
  test('uses deterministic same-slot keys without exposing the client ID', () => {
    const first = redisKeyPair('sensitive-client');
    const second = redisKeyPair('sensitive-client');

    expect(first).toEqual(second);
    expect(first.policy).toMatch(
      /^rate-limiter:\{[a-f0-9]{64}\}:policy$/,
    );
    expect(first.events).toMatch(
      /^rate-limiter:\{[a-f0-9]{64}\}:events$/,
    );
    expect(first.policy).not.toContain('sensitive-client');
    expect(first.policy.match(/\{([^}]+)\}/)?.[1]).toBe(
      first.events.match(/\{([^}]+)\}/)?.[1],
    );
  });
});

describe('RedisRateLimitStore', () => {
  test('executes one atomic check with two same-slot keys', async () => {
    const executor = new FakeExecutor([1, 1, 2000, 1000, 0, 0]);
    const store = new RedisRateLimitStore(executor);

    await expect(
      store.check({ clientId: 'client-1', limit: 2, windowMs: 1000 }),
    ).resolves.toEqual({
      allowed: true,
      remaining: 1,
      resetAt: 2000,
      mode: 'redis',
    });

    expect(executor.calls).toHaveLength(1);
    const call = executor.calls[0];
    expect(call?.options.keys).toHaveLength(2);
    expect(call?.options.arguments.slice(0, 2)).toEqual(['2', '1000']);
    expect(call?.options.arguments[2]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  test('reports readiness and closes a ready executor cleanly', async () => {
    const executor = new FakeExecutor([1, 0, 2000, 1000, 0, 0]);
    const store = new RedisRateLimitStore(executor);

    expect(store.health()).toEqual({ status: 'healthy', mode: 'redis' });
    await store.close();
    expect(executor.closed).toBe(true);
  });

  test('destroys an executor that is not ready during close', async () => {
    const executor = new FakeExecutor([1, 0, 2000, 1000, 0, 0]);
    executor.isReady = false;
    const store = new RedisRateLimitStore(executor);

    expect(store.health()).toEqual({
      status: 'unhealthy',
      mode: 'redis',
      detail: 'Redis connection is not ready',
    });
    await store.close();
    expect(executor.closed).toBe(true);
  });

  test('reports bounded process-observed active clients until reset', async () => {
    let now = 1000;
    const executor = new FakeExecutor([1, 1, 2000, 1000, 0, 0]);
    const store = new RedisRateLimitStore(executor, {
      observationClock: () => now,
      maxObservedClients: 2,
    });

    await store.check({ clientId: 'client-a', limit: 2, windowMs: 1000 });
    await store.check({ clientId: 'client-a', limit: 2, windowMs: 1000 });
    await store.check({ clientId: 'client-b', limit: 2, windowMs: 1000 });
    expect(store.activeClients()).toBe(2);

    await store.check({ clientId: 'client-c', limit: 2, windowMs: 1000 });
    expect(store.activeClients()).toBe(2);

    now = 2000;
    expect(store.activeClients()).toBe(0);
  });
});
