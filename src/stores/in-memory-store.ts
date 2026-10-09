import { TimestampQueue } from '../algorithms/timestamp-queue';
import type { Clock } from '../domain/clock';
import { PolicyConflictError } from '../domain/errors';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitPolicy,
  RateLimitStore,
  StoreHealth,
} from '../domain/types';

export interface InMemoryStoreOptions {
  clock: Clock;
  maxClients: number;
  maxTotalTimestamps: number;
  maxTimestampsPerClient: number;
}

interface ClientState {
  policy: RateLimitPolicy;
  timestamps: TimestampQueue;
}

export class InMemoryRateLimitStore implements RateLimitStore {
  readonly #clients = new Map<string, ClientState>();
  readonly #clock: Clock;
  readonly #maxClients: number;
  readonly #maxTotalTimestamps: number;
  readonly #maxTimestampsPerClient: number;
  #totalTimestamps = 0;

  constructor(options: InMemoryStoreOptions) {
    this.#clock = options.clock;
    this.#maxClients = options.maxClients;
    this.#maxTotalTimestamps = options.maxTotalTimestamps;
    this.#maxTimestampsPerClient = options.maxTimestampsPerClient;
  }

  async check(command: RateLimitCommand): Promise<RateLimitDecision> {
    const now = this.#clock.now();
    let state = this.#clients.get(command.clientId);

    if (state !== undefined) {
      this.#pruneState(state, now - state.policy.windowMs);
      if (state.timestamps.length === 0) {
        this.#clients.delete(command.clientId);
        state = undefined;
      }
    }

    if (state !== undefined && !this.#samePolicy(state.policy, command)) {
      throw new PolicyConflictError({ ...state.policy });
    }

    if (state === undefined) {
      state = {
        policy: { limit: command.limit, windowMs: command.windowMs },
        timestamps: new TimestampQueue(),
      };
      this.#clients.set(command.clientId, state);
    }

    const oldest = state.timestamps.oldest();
    if (state.timestamps.length >= command.limit) {
      if (oldest === undefined) {
        throw new Error('active timestamp queue is unexpectedly empty');
      }
      const resetAt = oldest + command.windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(1, resetAt - now),
        mode: 'memory',
      };
    }

    state.timestamps.push(now);
    this.#totalTimestamps += 1;
    const resetAt = (state.timestamps.oldest() ?? now) + command.windowMs;

    return {
      allowed: true,
      remaining: command.limit - state.timestamps.length,
      resetAt,
      mode: 'memory',
    };
  }

  activeClients(): number {
    return this.#clients.size;
  }

  health(): StoreHealth {
    return { status: 'healthy', mode: 'memory' };
  }

  async close(): Promise<void> {}

  #pruneState(state: ClientState, cutoff: number): void {
    this.#totalTimestamps -= state.timestamps.prune(cutoff);
  }

  #samePolicy(active: RateLimitPolicy, requested: RateLimitPolicy): boolean {
    return (
      active.limit === requested.limit && active.windowMs === requested.windowMs
    );
  }
}
