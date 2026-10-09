import { afterAll, afterEach, beforeAll, describe, expect, test } from '@jest/globals';
import { createClient } from 'redis';

import {
  RedisRateLimitStore,
  redisKeyPair,
  type RedisScriptExecutor,
} from '../../src/stores/redis-store';

const describeRedis = process.env.RUN_REDIS_TESTS === '1' ? describe : describe.skip;
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const sleep = async (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

describeRedis('RedisRateLimitStore integration', () => {
  const client = createClient({ url: redisUrl, disableOfflineQueue: true });
  const executor: RedisScriptExecutor = {
    get isReady() {
      return client.isReady;
    },
    async eval(script, options) {
      return client.eval(script, options);
    },
    async quit() {
      return client.quit();
    },
    destroy() {
      client.destroy();
    },
  };
  const store = new RedisRateLimitStore(executor);

  beforeAll(async () => {
    client.on('error', () => undefined);
    await client.connect();
  });

  afterEach(async () => {
    await client.flushDb();
  });

  afterAll(async () => {
    if (client.isOpen) {
      await client.quit();
    }
  });

  test('atomically allows exactly the configured limit under concurrency', async () => {
    const decisions = await Promise.all(
      Array.from({ length: 100 }, async () =>
        store.check({ clientId: 'concurrent', limit: 10, windowMs: 10_000 }),
      ),
    );

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(10);
    expect(decisions.filter((decision) => !decision.allowed)).toHaveLength(90);
  });

  test('stores every same-window event as a unique sorted-set member', async () => {
    await Promise.all(
      Array.from({ length: 50 }, async () =>
        store.check({ clientId: 'unique', limit: 50, windowMs: 10_000 }),
      ),
    );
    const keys = redisKeyPair('unique');

    expect(await client.zCard(keys.events)).toBe(50);
  });

  test('rejects policy changes while state is active and accepts them after expiry', async () => {
    await store.check({ clientId: 'policy', limit: 2, windowMs: 50 });

    await expect(
      store.check({ clientId: 'policy', limit: 3, windowMs: 50 }),
    ).rejects.toMatchObject({ code: 'POLICY_CONFLICT' });

    await sleep(80);
    await expect(
      store.check({ clientId: 'policy', limit: 3, windowMs: 100 }),
    ).resolves.toMatchObject({ allowed: true, remaining: 2 });
  });

  test('expires inactive policy and event keys', async () => {
    const keys = redisKeyPair('expiring');
    await store.check({ clientId: 'expiring', limit: 1, windowMs: 50 });
    expect(await client.exists([keys.policy, keys.events])).toBe(2);

    await sleep(100);
    expect(await client.exists([keys.policy, keys.events])).toBe(0);
  });
});
