export type StoreMode = 'memory' | 'redis';
export type FailurePolicy = 'open' | 'closed';

export interface AppConfig {
  host: string;
  port: number;
  logLevel: string;
  storeMode: StoreMode;
  redisUrl: string | undefined;
  failurePolicy: FailurePolicy;
  maxClients: number;
  maxTotalTimestamps: number;
  maxTimestampsPerClient: number;
  maxLimit: number;
  minWindowMs: number;
  maxWindowMs: number;
  cleanupIntervalMs: number;
  maxInFlight: number;
  redisTimeoutMs: number;
  circuitCooldownMs: number;
}

function positiveInteger(
  name: string,
  rawValue: string | undefined,
  fallback: number,
): number {
  const value = rawValue === undefined ? fallback : Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function storeMode(rawValue: string | undefined): StoreMode {
  const value = rawValue ?? 'memory';
  if (value !== 'memory' && value !== 'redis') {
    throw new Error('STORE_MODE must be memory or redis');
  }
  return value;
}

function failurePolicy(rawValue: string | undefined): FailurePolicy {
  const value = rawValue ?? 'open';
  if (value !== 'open' && value !== 'closed') {
    throw new Error('FAILURE_POLICY must be open or closed');
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const selectedStoreMode = storeMode(env.STORE_MODE);
  const redisUrl = env.REDIS_URL?.trim() || undefined;
  const port = positiveInteger('PORT', env.PORT, 3000);
  const maxClients = positiveInteger('MAX_CLIENTS', env.MAX_CLIENTS, 100_000);
  const maxTotalTimestamps = positiveInteger(
    'MAX_TOTAL_TIMESTAMPS',
    env.MAX_TOTAL_TIMESTAMPS,
    1_000_000,
  );
  const maxTimestampsPerClient = positiveInteger(
    'MAX_TIMESTAMPS_PER_CLIENT',
    env.MAX_TIMESTAMPS_PER_CLIENT,
    10_000,
  );
  const maxLimit = positiveInteger('MAX_LIMIT', env.MAX_LIMIT, 10_000);
  const minWindowMs = positiveInteger('MIN_WINDOW_MS', env.MIN_WINDOW_MS, 100);
  const maxWindowMs = positiveInteger(
    'MAX_WINDOW_MS',
    env.MAX_WINDOW_MS,
    3_600_000,
  );

  if (port > 65_535) {
    throw new Error('PORT must be at most 65535');
  }
  if (selectedStoreMode === 'redis' && redisUrl === undefined) {
    throw new Error('REDIS_URL is required when STORE_MODE is redis');
  }
  if (minWindowMs > maxWindowMs) {
    throw new Error('MIN_WINDOW_MS must not exceed MAX_WINDOW_MS');
  }
  if (maxTimestampsPerClient > maxTotalTimestamps) {
    throw new Error(
      'MAX_TIMESTAMPS_PER_CLIENT must not exceed MAX_TOTAL_TIMESTAMPS',
    );
  }
  if (maxLimit > maxTimestampsPerClient) {
    throw new Error('MAX_LIMIT must not exceed MAX_TIMESTAMPS_PER_CLIENT');
  }

  return {
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    logLevel: env.LOG_LEVEL?.trim() || 'info',
    storeMode: selectedStoreMode,
    redisUrl,
    failurePolicy: failurePolicy(env.FAILURE_POLICY),
    maxClients,
    maxTotalTimestamps,
    maxTimestampsPerClient,
    maxLimit,
    minWindowMs,
    maxWindowMs,
    cleanupIntervalMs: positiveInteger(
      'CLEANUP_INTERVAL_MS',
      env.CLEANUP_INTERVAL_MS,
      30_000,
    ),
    maxInFlight: positiveInteger('MAX_IN_FLIGHT', env.MAX_IN_FLIGHT, 1_000),
    redisTimeoutMs: positiveInteger(
      'REDIS_TIMEOUT_MS',
      env.REDIS_TIMEOUT_MS,
      100,
    ),
    circuitCooldownMs: positiveInteger(
      'CIRCUIT_COOLDOWN_MS',
      env.CIRCUIT_COOLDOWN_MS,
      5_000,
    ),
  };
}
