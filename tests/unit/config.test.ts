import { describe, expect, test } from '@jest/globals';

import { loadConfig } from '../../src/config/config';

describe('loadConfig', () => {
  test('loads availability-first defaults', () => {
    const config = loadConfig({});

    expect(config).toMatchObject({
      storeMode: 'memory',
      failurePolicy: 'open',
      maxClients: 100_000,
      maxTotalTimestamps: 1_000_000,
      maxLimit: 10_000,
      maxInFlight: 1_000,
      redisTimeoutMs: 100,
      circuitCooldownMs: 5_000,
    });
  });

  test.each(['0', '-1', '1.5', 'abc'])(
    'rejects invalid MAX_LIMIT=%s',
    (value) => {
      expect(() => loadConfig({ MAX_LIMIT: value })).toThrow('MAX_LIMIT');
    },
  );

  test('requires REDIS_URL in redis mode', () => {
    expect(() => loadConfig({ STORE_MODE: 'redis' })).toThrow('REDIS_URL');
  });

  test('rejects a minimum window greater than the maximum', () => {
    expect(() =>
      loadConfig({ MIN_WINDOW_MS: '2000', MAX_WINDOW_MS: '1000' }),
    ).toThrow('MIN_WINDOW_MS');
  });

  test('rejects a per-client timestamp cap above the global cap', () => {
    expect(() =>
      loadConfig({
        MAX_TIMESTAMPS_PER_CLIENT: '101',
        MAX_TOTAL_TIMESTAMPS: '100',
      }),
    ).toThrow('MAX_TIMESTAMPS_PER_CLIENT');
  });

  test('rejects a policy limit above the per-client timestamp cap', () => {
    expect(() =>
      loadConfig({ MAX_LIMIT: '101', MAX_TIMESTAMPS_PER_CLIENT: '100' }),
    ).toThrow('MAX_LIMIT');
  });
});
