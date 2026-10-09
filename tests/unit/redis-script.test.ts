import { describe, expect, test } from '@jest/globals';

import { decodeRedisDecision } from '../../src/stores/redis-script';

describe('decodeRedisDecision', () => {
  test('decodes an allowed Redis tuple', () => {
    expect(decodeRedisDecision([1, 2, 5000, 4000, 0, 0])).toEqual({
      allowed: true,
      remaining: 2,
      resetAt: 5000,
      mode: 'redis',
    });
  });

  test('derives retry time from a rejected Redis tuple', () => {
    expect(decodeRedisDecision([0, 0, 5000, 4200, 0, 0])).toEqual({
      allowed: false,
      remaining: 0,
      resetAt: 5000,
      retryAfterMs: 800,
      mode: 'redis',
    });
  });

  test('turns an active policy mismatch into a typed conflict', () => {
    expect(() =>
      decodeRedisDecision([-1, 0, 0, 4200, 100, 60_000]),
    ).toThrow(
      expect.objectContaining({
        code: 'POLICY_CONFLICT',
        activePolicy: { limit: 100, windowMs: 60_000 },
      }),
    );
  });

  test.each([
    null,
    [],
    [1, 2],
    [2, 0, 5000, 4000, 0, 0],
    [1, 'not-a-number', 5000, 4000, 0, 0],
  ])('rejects malformed script reply %#', (reply) => {
    expect(() => decodeRedisDecision(reply)).toThrow(
      expect.objectContaining({ code: 'STORE_UNAVAILABLE' }),
    );
  });
});
