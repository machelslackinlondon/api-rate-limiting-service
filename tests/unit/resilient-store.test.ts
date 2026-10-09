import { describe, expect, jest, test } from '@jest/globals';

import type { Clock } from '../../src/domain/clock';
import { StoreUnavailableError } from '../../src/domain/errors';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from '../../src/domain/types';
import { ResilientRateLimitStore } from '../../src/stores/resilient-store';

const command: RateLimitCommand = {
  clientId: 'client-1',
  limit: 2,
  windowMs: 1000,
};

const redisDecision: RateLimitDecision = {
  allowed: true,
  remaining: 1,
  resetAt: 2000,
  mode: 'redis',
};

const memoryDecision: RateLimitDecision = {
  allowed: true,
  remaining: 1,
  resetAt: 2000,
  mode: 'memory',
};

class FakeClock implements Clock {
  constructor(public value: number) {}
  now(): number {
    return this.value;
  }
}

class ScriptedStore implements RateLimitStore {
  calls = 0;
  closed = false;

  constructor(
    public handler: (value: RateLimitCommand) => Promise<RateLimitDecision>,
    private readonly storeHealth: StoreHealth,
  ) {}

  check(value: RateLimitCommand): Promise<RateLimitDecision> {
    this.calls += 1;
    return this.handler(value);
  }

  health(): StoreHealth {
    return this.storeHealth;
  }

  activeClients(): number {
    return 1;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function createStores(primaryHandler: ScriptedStore['handler']): {
  primary: ScriptedStore;
  fallback: ScriptedStore;
} {
  return {
    primary: new ScriptedStore(primaryHandler, {
      status: 'healthy',
      mode: 'redis',
    }),
    fallback: new ScriptedStore(async () => memoryDecision, {
      status: 'healthy',
      mode: 'memory',
    }),
  };
}

describe('ResilientRateLimitStore', () => {
  test('returns primary decisions while Redis is healthy', async () => {
    const clock = new FakeClock(1000);
    const stores = createStores(async () => redisDecision);
    const store = new ResilientRateLimitStore({
      ...stores,
      clock,
      failurePolicy: 'open',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await expect(store.check(command)).resolves.toEqual(redisDecision);
    expect(store.circuitState).toBe('closed');
    expect(stores.fallback.calls).toBe(0);
  });

  test('opens the circuit and relabels a fail-open fallback decision', async () => {
    const clock = new FakeClock(1000);
    const stores = createStores(async () => {
      throw new Error('Redis unavailable');
    });
    const store = new ResilientRateLimitStore({
      ...stores,
      clock,
      failurePolicy: 'open',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await expect(store.check(command)).resolves.toEqual({
      ...memoryDecision,
      mode: 'fallback',
    });
    expect(store.health()).toEqual({
      status: 'degraded',
      mode: 'fallback',
      circuitState: 'open',
      detail: 'Redis unavailable; using local fallback',
    });

    await store.check(command);
    expect(stores.primary.calls).toBe(1);
    expect(stores.fallback.calls).toBe(2);
  });

  test('times out a slow primary and consumes its eventual rejection', async () => {
    jest.useFakeTimers();
    const clock = new FakeClock(1000);
    let rejectPrimary: ((reason: Error) => void) | undefined;
    const stores = createStores(
      () =>
        new Promise<RateLimitDecision>((_resolve, reject) => {
          rejectPrimary = reject;
        }),
    );
    const store = new ResilientRateLimitStore({
      ...stores,
      clock,
      failurePolicy: 'open',
      timeoutMs: 10,
      cooldownMs: 5000,
    });

    const result = store.check(command);
    await jest.advanceTimersByTimeAsync(10);
    await expect(result).resolves.toMatchObject({ mode: 'fallback' });
    rejectPrimary?.(new Error('late Redis rejection'));
    await Promise.resolve();
    jest.useRealTimers();
  });

  test('allows one recovery probe and routes concurrent checks to fallback', async () => {
    const clock = new FakeClock(1000);
    let resolveProbe: ((decision: RateLimitDecision) => void) | undefined;
    const stores = createStores(async () => {
      if (stores.primary.calls === 1) {
        throw new Error('initial failure');
      }
      return new Promise<RateLimitDecision>((resolve) => {
        resolveProbe = resolve;
      });
    });
    const store = new ResilientRateLimitStore({
      ...stores,
      clock,
      failurePolicy: 'open',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await store.check(command);
    clock.value = 6000;
    const probe = store.check(command);
    expect(store.circuitState).toBe('half-open');
    await expect(store.check(command)).resolves.toMatchObject({ mode: 'fallback' });
    expect(stores.primary.calls).toBe(2);

    resolveProbe?.(redisDecision);
    await expect(probe).resolves.toEqual(redisDecision);
    expect(store.circuitState).toBe('closed');
  });

  test('reopens after a failed recovery probe', async () => {
    const clock = new FakeClock(1000);
    const stores = createStores(async () => {
      throw new Error('still unavailable');
    });
    const store = new ResilientRateLimitStore({
      ...stores,
      clock,
      failurePolicy: 'open',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await store.check(command);
    clock.value = 6000;
    await expect(store.check(command)).resolves.toMatchObject({ mode: 'fallback' });
    expect(store.circuitState).toBe('open');
    expect(stores.primary.calls).toBe(2);
  });

  test('fails closed without invoking fallback when configured', async () => {
    const stores = createStores(async () => {
      throw new Error('Redis unavailable');
    });
    const store = new ResilientRateLimitStore({
      ...stores,
      clock: new FakeClock(1000),
      failurePolicy: 'closed',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await expect(store.check(command)).rejects.toBeInstanceOf(StoreUnavailableError);
    await expect(store.check(command)).rejects.toBeInstanceOf(StoreUnavailableError);
    expect(stores.primary.calls).toBe(1);
    expect(stores.fallback.calls).toBe(0);
  });

  test('closes both primary and fallback stores', async () => {
    const stores = createStores(async () => redisDecision);
    const store = new ResilientRateLimitStore({
      ...stores,
      clock: new FakeClock(1000),
      failurePolicy: 'open',
      timeoutMs: 100,
      cooldownMs: 5000,
    });

    await store.close();
    expect(stores.primary.closed).toBe(true);
    expect(stores.fallback.closed).toBe(true);
  });
});
