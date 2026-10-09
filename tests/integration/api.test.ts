import { afterEach, describe, expect, test } from '@jest/globals';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app';
import { loadConfig } from '../../src/config/config';
import type { Clock } from '../../src/domain/clock';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from '../../src/domain/types';

class FakeClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

class PendingStore implements RateLimitStore {
  closed = false;
  resolve: ((decision: RateLimitDecision) => void) | undefined;

  check(_command: RateLimitCommand): Promise<RateLimitDecision> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  health(): StoreHealth {
    return { status: 'healthy', mode: 'memory' };
  }

  activeClients(): number {
    return 0;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function memoryApp(
  env: NodeJS.ProcessEnv = {},
  clock: Clock = new FakeClock(1000),
): Promise<FastifyInstance> {
  const app = await buildApp({
    config: loadConfig({ LOG_LEVEL: 'silent', ...env }),
    clock,
  });
  apps.push(app);
  return app;
}

describe('rate limit API', () => {
  test('returns an allowed decision and then a 429 with retry metadata', async () => {
    const app = await memoryApp();
    const payload = { clientId: 'client-123', limit: 1, windowMs: 1000 };

    const allowed = await app.inject({ method: 'POST', url: '/check', payload });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({
      allowed: true,
      remaining: 0,
      resetAt: 2000,
      mode: 'memory',
    });

    const rejected = await app.inject({ method: 'POST', url: '/check', payload });
    expect(rejected.statusCode).toBe(429);
    expect(rejected.headers['retry-after']).toBe('1');
    expect(rejected.json()).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 2000,
      retryAfterMs: 1000,
      mode: 'memory',
    });
  });

  test('returns 409 when a client changes its active policy', async () => {
    const app = await memoryApp();
    await app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'locked', limit: 2, windowMs: 1000 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'locked', limit: 3, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: {
        code: 'POLICY_CONFLICT',
        message: 'limit and windowMs must match the active client policy',
      },
    });
  });

  test.each([
    [{ clientId: '', limit: 1, windowMs: 1000 }, 'clientId'],
    [{ clientId: 'has spaces', limit: 1, windowMs: 1000 }, 'clientId'],
    [{ clientId: 'valid', limit: 0, windowMs: 1000 }, 'limit'],
    [{ clientId: 'valid', limit: 1, windowMs: 99 }, 'windowMs'],
    [
      { clientId: 'valid', limit: 1, windowMs: 1000, timestamp: 1000 },
      'timestamp',
    ],
  ])('rejects invalid input %#', async (payload, field) => {
    const app = await memoryApp();
    const response = await app.inject({ method: 'POST', url: '/check', payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(response.body).toContain(field);
    expect(response.body).not.toContain('stack');
  });

  test('rejects a JSON body above 8 KiB', async () => {
    const app = await memoryApp();
    const response = await app.inject({
      method: 'POST',
      url: '/check',
      payload: {
        clientId: 'valid',
        limit: 1,
        windowMs: 1000,
        padding: 'x'.repeat(9000),
      },
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: { code: 'PAYLOAD_TOO_LARGE' },
    });
  });

  test('returns 503 when state capacity is exhausted', async () => {
    const app = await memoryApp({ MAX_CLIENTS: '1' });
    await app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'first', limit: 2, windowMs: 1000 },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'second', limit: 2, windowMs: 1000 },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: 'CAPACITY_EXHAUSTED' },
    });
  });

  test('does not place health checks behind saturated admission', async () => {
    const store = new PendingStore();
    const app = await buildApp({
      config: loadConfig({ LOG_LEVEL: 'silent', MAX_IN_FLIGHT: '1' }),
      store,
      clock: new FakeClock(1000),
    });
    apps.push(app);
    const first = app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'first', limit: 1, windowMs: 1000 },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const overloaded = await app.inject({
      method: 'POST',
      url: '/check',
      payload: { clientId: 'second', limit: 1, windowMs: 1000 },
    });
    expect(overloaded.statusCode).toBe(503);
    expect(overloaded.json()).toMatchObject({ error: { code: 'OVERLOADED' } });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'healthy', mode: 'memory' });

    store.resolve?.({
      allowed: true,
      remaining: 0,
      resetAt: 2000,
      mode: 'memory',
    });
    await first;
  });

  test('closes the configured store with the Fastify lifecycle', async () => {
    const store = new PendingStore();
    const app = await buildApp({
      config: loadConfig({ LOG_LEVEL: 'silent' }),
      store,
      clock: new FakeClock(1000),
    });

    await app.close();
    expect(store.closed).toBe(true);
  });
});
