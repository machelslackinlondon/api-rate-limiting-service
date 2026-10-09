import { AdmissionController } from './admission-controller';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from './types';

export interface RateLimiterObserver {
  observeDecision(decision: RateLimitDecision, durationSeconds: number): void;
  observeFailure(error: unknown, durationSeconds: number): void;
}

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly admission: AdmissionController,
    private readonly observer: RateLimiterObserver | undefined = undefined,
  ) {}

  async check(command: RateLimitCommand): Promise<RateLimitDecision> {
    const startedAt = performance.now();
    try {
      const decision = await this.admission.run(async () => this.store.check(command));
      this.observer?.observeDecision(
        decision,
        (performance.now() - startedAt) / 1000,
      );
      return decision;
    } catch (error) {
      this.observer?.observeFailure(error, (performance.now() - startedAt) / 1000);
      throw error;
    }
  }

  health(): StoreHealth {
    return this.store.health();
  }

  activeClients(): number {
    return this.store.activeClients();
  }

  close(): Promise<void> {
    return this.store.close();
  }
}
