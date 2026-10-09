import { AdmissionController } from './admission-controller';
import type {
  RateLimitCommand,
  RateLimitDecision,
  RateLimitStore,
  StoreHealth,
} from './types';

export class RateLimiter {
  constructor(
    private readonly store: RateLimitStore,
    private readonly admission: AdmissionController,
  ) {}

  check(command: RateLimitCommand): Promise<RateLimitDecision> {
    return this.admission.run(async () => this.store.check(command));
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
