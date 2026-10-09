export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface RateLimitCommand extends RateLimitPolicy {
  clientId: string;
}

export type StoreMode = 'memory' | 'redis' | 'fallback';

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterMs?: number;
  mode: StoreMode;
}

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface StoreHealth {
  status: HealthStatus;
  mode: StoreMode;
  circuitState?: 'closed' | 'open' | 'half-open';
  detail?: string;
}

export interface RateLimitStore {
  check(command: RateLimitCommand): Promise<RateLimitDecision>;
  health(): StoreHealth;
  activeClients(): number;
  close(): Promise<void>;
}
