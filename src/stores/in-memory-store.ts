import { TimestampQueue } from '../algorithms/timestamp-queue';
import type { Clock } from '../domain/clock';
import { CapacityError, PolicyConflictError } from '../domain/errors';
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

    const oldest = state?.timestamps.oldest();
    if (state !== undefined && state.timestamps.length >= command.limit) {
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

    if (state === undefined) {
      this.#ensureClientCapacity();
      state = {
        policy: { limit: command.limit, windowMs: command.windowMs },
        timestamps: new TimestampQueue(),
      };
    }

    this.#ensureTimestampCapacity(state);

    state.timestamps.push(now);
    this.#totalTimestamps += 1;
    this.#clients.set(command.clientId, state);
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

  cleanup(): { clientsRemoved: number; timestampsRemoved: number } {
    const now = this.#clock.now();
    let clientsRemoved = 0;
    let timestampsRemoved = 0;

    for (const [clientId, state] of this.#clients) {
      timestampsRemoved += this.#pruneState(
        state,
        now - state.policy.windowMs,
      );
      if (state.timestamps.length === 0) {
        this.#clients.delete(clientId);
        clientsRemoved += 1;
      }
    }

    return { clientsRemoved, timestampsRemoved };
  }

  #pruneState(state: ClientState, cutoff: number): number {
    const removed = state.timestamps.prune(cutoff);
    this.#totalTimestamps -= removed;
    return removed;
  }

  #samePolicy(active: RateLimitPolicy, requested: RateLimitPolicy): boolean {
    return (
      active.limit === requested.limit && active.windowMs === requested.windowMs
    );
  }

  #ensureClientCapacity(): void {
    if (this.#clients.size < this.#maxClients) {
      return;
    }

    this.cleanup();
    if (this.#clients.size >= this.#maxClients) {
      throw new CapacityError('maximum tracked clients reached');
    }
  }

  #ensureTimestampCapacity(state: ClientState): void {
    if (state.timestamps.length >= this.#maxTimestampsPerClient) {
      throw new CapacityError('maximum timestamps per client reached');
    }

    if (this.#totalTimestamps < this.#maxTotalTimestamps) {
      return;
    }

    this.cleanup();
    if (this.#totalTimestamps >= this.#maxTotalTimestamps) {
      throw new CapacityError('maximum total timestamps reached');
    }
  }
}
