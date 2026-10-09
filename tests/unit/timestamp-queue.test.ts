import { describe, expect, test } from '@jest/globals';

import { TimestampQueue } from '../../src/algorithms/timestamp-queue';

describe('TimestampQueue', () => {
  test('prunes the exact cutoff and retains newer timestamps', () => {
    const queue = new TimestampQueue();
    [1000, 1001, 1500].forEach((value) => queue.push(value));

    expect(queue.prune(1000)).toBe(1);
    expect(queue.length).toBe(2);
    expect(queue.oldest()).toBe(1001);
    expect(queue.newest()).toBe(1500);
  });

  test('preserves logical order after enough consumed entries to compact', () => {
    const queue = new TimestampQueue({ compactAt: 4 });
    [1, 2, 3, 4, 5, 6].forEach((value) => queue.push(value));

    expect(queue.prune(4)).toBe(4);
    expect(queue.length).toBe(2);
    expect(queue.oldest()).toBe(5);

    queue.push(7);
    expect(queue.prune(5)).toBe(1);
    expect(queue.oldest()).toBe(6);
    expect(queue.newest()).toBe(7);
  });

  test('resets to an empty queue when every timestamp expires', () => {
    const queue = new TimestampQueue();
    queue.push(10);
    queue.push(20);

    expect(queue.prune(20)).toBe(2);
    expect(queue.length).toBe(0);
    expect(queue.oldest()).toBeUndefined();
    expect(queue.newest()).toBeUndefined();
  });

  test('rejects timestamps older than the newest retained value', () => {
    const queue = new TimestampQueue();
    queue.push(100);

    expect(() => queue.push(99)).toThrow('monotonic');
  });
});
