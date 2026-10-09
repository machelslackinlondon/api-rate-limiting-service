import type { Clock } from '../domain/clock';
import { PolicyConflictError, StoreUnavailableError } from '../domain/errors';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from '../domain/types';
import type { FailurePolicy } from '../config/config';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface ResilientStoreOptions {
  primary: RateLimitStore;
  fallback: RateLimitStore;
  clock: Clock;
  failurePolicy: FailurePolicy;
  timeoutMs: number;
  cooldownMs: number;
  onStoreError?: (error: Error) => void;
  onFallback?: () => void;
  onCircuitStateChange?: (state: CircuitState) => void;
}

export class ResilientRateLimitStore implements RateLimitStore {
  readonly #primary: RateLimitStore;
  readonly #fallback: RateLimitStore;
  readonly #clock: Clock;
  readonly #failurePolicy: FailurePolicy;
  readonly #timeoutMs: number;
  readonly #cooldownMs: number;
  readonly #onStoreError: ((error: Error) => void) | undefined;
  readonly #onFallback: (() => void) | undefined;
  readonly #onCircuitStateChange: ((state: CircuitState) => void) | undefined;
  #state: CircuitState = 'closed';
  #openUntil = 0;

  constructor(options: ResilientStoreOptions) {
    this.#primary = options.primary;
    this.#fallback = options.fallback;
    this.#clock = options.clock;
    this.#failurePolicy = options.failurePolicy;
    this.#timeoutMs = options.timeoutMs;
    this.#cooldownMs = options.cooldownMs;
    this.#onStoreError = options.onStoreError;
    this.#onFallback = options.onFallback;
    this.#onCircuitStateChange = options.onCircuitStateChange;
  }

  get circuitState(): CircuitState {
    return this.#state;
  }

  async check(command: RateLimitCommand): Promise<RateLimitDecision> {
    if (this.#state === 'open') {
      if (this.#clock.now() < this.#openUntil) {
        return this.#fallbackOrThrow(command);
      }
      this.#setState('half-open');
      return this.#tryPrimary(command);
    }

    if (this.#state === 'half-open') {
      return this.#fallbackOrThrow(command);
    }

    return this.#tryPrimary(command);
  }

  activeClients(): number {
    return this.#state === 'closed'
      ? this.#primary.activeClients()
      : this.#fallback.activeClients();
  }

  health(): StoreHealth {
    if (this.#state === 'closed') {
      return this.#primary.health();
    }

    if (this.#failurePolicy === 'open') {
      return {
        status: 'degraded',
        mode: 'fallback',
        circuitState: this.#state,
        detail: 'Redis unavailable; using local fallback',
      };
    }

    return {
      status: 'unhealthy',
      mode: 'redis',
      circuitState: this.#state,
      detail: 'Redis unavailable; fail-closed policy is active',
    };
  }

  async close(): Promise<void> {
    const results = await Promise.allSettled([
      this.#primary.close(),
      this.#fallback.close(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  async #tryPrimary(command: RateLimitCommand): Promise<RateLimitDecision> {
    try {
      const decision = await this.#withTimeout(this.#primary.check(command));
      this.#setState('closed');
      return decision;
    } catch (error) {
      if (error instanceof PolicyConflictError) {
        this.#setState('closed');
        throw error;
      }

      const operationalError =
        error instanceof Error ? error : new Error('unknown Redis error');
      this.#onStoreError?.(operationalError);
      this.#openUntil = this.#clock.now() + this.#cooldownMs;
      this.#setState('open');
      return this.#fallbackOrThrow(command, operationalError);
    }
  }

  async #fallbackOrThrow(
    command: RateLimitCommand,
    cause?: Error,
  ): Promise<RateLimitDecision> {
    if (this.#failurePolicy === 'closed') {
      throw new StoreUnavailableError(
        cause === undefined
          ? 'Redis unavailable while fail-closed policy is active'
          : `Redis unavailable: ${cause.message}`,
      );
    }

    this.#onFallback?.();
    const decision = await this.#fallback.check(command);
    return { ...decision, mode: 'fallback' };
  }

  async #withTimeout(
    operation: Promise<RateLimitDecision>,
  ): Promise<RateLimitDecision> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new StoreUnavailableError('Redis operation timed out'));
      }, this.#timeoutMs);
    });

    void operation.catch(() => undefined);
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  #setState(state: CircuitState): void {
    if (this.#state === state) {
      return;
    }
    this.#state = state;
    this.#onCircuitStateChange?.(state);
  }
}
