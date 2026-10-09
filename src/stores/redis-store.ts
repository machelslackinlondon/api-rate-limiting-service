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

export function redisKeyPair(clientId: string): RedisKeyPair {
  const digest = createHash('sha256').update(clientId).digest('hex');
  const prefix = `rate-limiter:{${digest}}`;
  return {
    policy: `${prefix}:policy`,
    events: `${prefix}:events`,
  };
}

export class RedisRateLimitStore implements RateLimitStore {
  constructor(private readonly executor: RedisScriptExecutor) {}

  async check(command: RateLimitCommand): Promise<RateLimitDecision> {
    const keys = redisKeyPair(command.clientId);
    const reply = await this.executor.eval(SLIDING_WINDOW_SCRIPT, {
      keys: [keys.policy, keys.events],
      arguments: [String(command.limit), String(command.windowMs), randomUUID()],
    });

    return decodeRedisDecision(reply);
  }

  activeClients(): number {
    return 0;
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
}
