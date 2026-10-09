import {
  collectDefaultMetrics,
  Counter,
  Gauge,
  Histogram,
  Registry,
} from '@prometheus-io/client';

import { OverloadedError } from '../domain/errors';
import type { RateLimitDecision } from '../domain/types';
import type { CircuitState } from '../stores/resilient-store';

export interface LimiterMetricsOptions {
  activeClients: () => number;
}

export class LimiterMetrics {
  readonly #registry = new Registry();
  readonly #requests: Counter<'mode' | 'outcome'>;
  readonly #allowed: Counter<'mode'>;
  readonly #rejected: Counter<'mode'>;
  readonly #latency: Histogram<'mode' | 'outcome'>;
  readonly #storeErrors: Counter<'category'>;
  readonly #overloadRejections: Counter;
  readonly #fallbacks: Counter;
  readonly #circuitState: Gauge;

  constructor(options: LimiterMetricsOptions) {
    collectDefaultMetrics({ register: this.#registry });

    this.#requests = new Counter({
      name: 'rate_limiter_requests_total',
      help: 'Rate limiter evaluations by outcome and operating mode',
      labelNames: ['mode', 'outcome'] as const,
      registers: [this.#registry],
    });
    this.#allowed = new Counter({
      name: 'rate_limiter_allowed_total',
      help: 'Allowed rate limiter evaluations by operating mode',
      labelNames: ['mode'] as const,
      registers: [this.#registry],
    });
    this.#rejected = new Counter({
      name: 'rate_limiter_rejected_total',
      help: 'Policy-rejected rate limiter evaluations by operating mode',
      labelNames: ['mode'] as const,
      registers: [this.#registry],
    });
    this.#latency = new Histogram({
      name: 'rate_limiter_latency_seconds',
      help: 'Rate limiter evaluation latency in seconds',
      labelNames: ['mode', 'outcome'] as const,
      buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
      registers: [this.#registry],
    });
    this.#storeErrors = new Counter({
      name: 'rate_limiter_store_errors_total',
      help: 'Store errors by stable category',
      labelNames: ['category'] as const,
      registers: [this.#registry],
    });
    this.#overloadRejections = new Counter({
      name: 'rate_limiter_overload_rejections_total',
      help: 'Checks rejected because processing capacity was exhausted',
      registers: [this.#registry],
    });
    this.#fallbacks = new Counter({
      name: 'rate_limiter_fallback_total',
      help: 'Checks routed to local fallback',
      registers: [this.#registry],
    });
    this.#circuitState = new Gauge({
      name: 'rate_limiter_circuit_state',
      help: 'Redis circuit state: closed=0, open=1, half-open=2',
      registers: [this.#registry],
    });
    this.#circuitState.set(0);

    const activeClients = options.activeClients;
    new Gauge({
      name: 'rate_limiter_active_clients',
      help: 'Active clients observed by this process',
      registers: [this.#registry],
      collect() {
        this.set(activeClients());
      },
    });
  }

  get contentType(): string {
    return this.#registry.contentType;
  }

  observeDecision(decision: RateLimitDecision, durationSeconds: number): void {
    const outcome = decision.allowed ? 'allowed' : 'rejected';
    this.#requests.inc({ mode: decision.mode, outcome });
    this.#latency.observe({ mode: decision.mode, outcome }, durationSeconds);
    if (decision.allowed) {
      this.#allowed.inc({ mode: decision.mode });
    } else {
      this.#rejected.inc({ mode: decision.mode });
    }
  }

  observeFailure(error: unknown, durationSeconds: number): void {
    this.#requests.inc({ mode: 'unknown', outcome: 'error' });
    this.#latency.observe(
      { mode: 'unknown', outcome: 'error' },
      durationSeconds,
    );
    if (error instanceof OverloadedError) {
      this.observeOverload();
    }
  }

  observeStoreError(error: Error): void {
    const possibleCode = (error as Error & { code?: unknown }).code;
    const category =
      typeof possibleCode === 'string' ? possibleCode.toLowerCase() : 'error';
    this.#storeErrors.inc({ category });
  }

  observeOverload(): void {
    this.#overloadRejections.inc();
  }

  observeFallback(): void {
    this.#fallbacks.inc();
  }

  setCircuitState(state: CircuitState): void {
    this.#circuitState.set(state === 'closed' ? 0 : state === 'open' ? 1 : 2);
  }

  render(): Promise<string> {
    return this.#registry.metrics();
  }
}
