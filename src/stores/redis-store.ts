import { createHash, randomUUID } from 'node:crypto';

import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from '../domain/types';
import {
  decodeRedisDecision,
  SLIDING_WINDOW_SCRIPT,
} from './redis-script';

export interface RedisEvalOptions {
  keys: string[];
  arguments: string[];
}

export interface RedisScriptExecutor {
  isReady: boolean;
  eval(script: string, options: RedisEvalOptions): Promise<unknown>;
  quit(): Promise<unknown>;
  destroy(): void;
}

export interface RedisKeyPair {
  policy: string;
  events: string;
}

export interface RedisStoreOptions {
  observationClock?: () => number;
  maxObservedClients?: number;
}

export function redisKeyPair(clientId: string): RedisKeyPair {
  const digest = createHash('sha256').update(clientId).digest('hex');
  const prefix = `rate-limiter:{${digest}}`;
  return {
    policy: `${prefix}:policy`,
    events: `${prefix}:events`,
  };
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly #observedClients = new Map<string, number>();
  readonly #observationClock: () => number;
  readonly #maxObservedClients: number;

  constructor(
    private readonly executor: RedisScriptExecutor,
    options: RedisStoreOptions = {},
  ) {
    this.#observationClock = options.observationClock ?? Date.now;
    this.#maxObservedClients = options.maxObservedClients ?? 100_000;
  }

  async check(command: RateLimitCommand): Promise<RateLimitDecision> {
    const keys = redisKeyPair(command.clientId);
    const reply = await this.executor.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [keys.policy, keys.events],
      arguments: [String(command.limit), String(command.windowMs), randomUUID()],
    });

    const decision = decodeRedisDecision(reply);
    this.#pruneObservedClients();
    if (
      this.#observedClients.has(keys.events) ||
      this.#observedClients.size < this.#maxObservedClients
    ) {
      this.#observedClients.set(keys.events, decision.resetAt);
    }
    return decision;
  }

  activeClients(): number {
    this.#pruneObservedClients();
    return this.#observedClients.size;
  }

  health(): StoreHealth {
    if (this.executor.isReady) {
      return { status: 'healthy', mode: 'redis' };
    }
    return {
      status: 'unhealthy',
      mode: 'redis',
      detail: 'Redis connection is not ready',
    };
  }

  async close(): Promise<void> {
    if (this.executor.isReady) {
      await this.executor.quit();
      return;
    }
    this.executor.destroy();
  }

  #pruneObservedClients(): void {
    const now = this.#observationClock();
    for (const [clientKey, resetAt] of this.#observedClients) {
      if (resetAt <= now) {
        this.#observedClients.delete(clientKey);
      }
    }
  }
}
