import Fastify, {
  type FastifyError,
  type FastifyInstance,
  type FastifyRequest,
} from 'fastify';
import { createClient } from 'redis';

import { registerRoutes } from './api/routes';
import type { AppConfig } from './config/config';
import type { Clock } from './domain/clock';
import { SystemClock } from './domain/clock';
import { AdmissionController } from './domain/admission-controller';
import { DomainError } from './domain/errors';
import { RateLimiter } from './domain/rate-limiter';
import type { RateLimitStore } from './domain/types';
import { InMemoryRateLimitStore } from './stores/in-memory-store';
import {
  RedisRateLimitStore,
  type RedisScriptExecutor,
} from './stores/redis-store';
import { ResilientRateLimitStore } from './stores/resilient-store';

export interface BuildAppOptions {
  config: AppConfig;
  clock?: Clock;
  store?: RateLimitStore;
}

interface CleanupStore {
  cleanup(): { clientsRemoved: number; timestampsRemoved: number };
}

function isCleanupStore(value: RateLimitStore): value is RateLimitStore & CleanupStore {
  return 'cleanup' in value && typeof value.cleanup === 'function';
}

function validationMessage(error: FastifyError): string {
  if (error.validation === undefined) {
    return error.message;
  }

  return error.validation
    .map((issue) => {
      const additional = issue.params['additionalProperty'];
      if (typeof additional === 'string') {
        return `unexpected property ${additional}`;
      }
      const field = issue.instancePath.replace(/^\//, '') || 'body';
      return `${field} ${issue.message ?? 'is invalid'}`;
    })
    .join('; ');
}

function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler(
    async (error: FastifyError, request: FastifyRequest, reply) => {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.statusCode === 413) {
        return reply.code(413).send({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'request body exceeds 8192 bytes',
          },
        });
      }

      if (error.validation !== undefined) {
        return reply.code(400).send({
          error: { code: 'VALIDATION_ERROR', message: validationMessage(error) },
        });
      }

      if (error instanceof DomainError) {
        return reply.code(error.statusCode).send({
          error: { code: error.code, message: error.message },
        });
      }

      request.log.error({ err: error }, 'unhandled request error');
      return reply.code(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'internal server error' },
      });
    },
  );
}

function memoryStore(config: AppConfig, clock: Clock): InMemoryRateLimitStore {
  return new InMemoryRateLimitStore({
    clock,
    maxClients: config.maxClients,
    maxTotalTimestamps: config.maxTotalTimestamps,
    maxTimestampsPerClient: config.maxTimestampsPerClient,
  });
}

async function redisStore(
  app: FastifyInstance,
  config: AppConfig,
  clock: Clock,
  cleanupTargets: CleanupStore[],
): Promise<RateLimitStore> {
  if (config.redisUrl === undefined) {
    throw new Error('REDIS_URL is required when STORE_MODE is redis');
  }
  const client = createClient({
    url: config.redisUrl,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: config.redisTimeoutMs,
      reconnectStrategy: false,
    },
  });
  client.on('error', (error) => {
    app.log.warn({ err: error }, 'Redis client error');
  });

  try {
    await client.connect();
  } catch (error) {
    app.log.warn({ err: error }, 'Redis unavailable during startup');
  }

  const executor: RedisScriptExecutor = {
    get isReady() {
      return client.isReady;
    },
    async eval(script, options) {
      return client.eval(script, options);
    },
    async quit() {
      return client.quit();
    },
    destroy() {
      client.destroy();
    },
  };
  const fallback = memoryStore(config, clock);
  cleanupTargets.push(fallback);

  return new ResilientRateLimitStore({
    primary: new RedisRateLimitStore(executor),
    fallback,
    clock,
    failurePolicy: config.failurePolicy,
    timeoutMs: config.redisTimeoutMs,
    cooldownMs: config.circuitCooldownMs,
    onStoreError(error) {
      app.log.warn({ err: error }, 'Redis limiter operation failed');
    },
    onFallback() {
      app.log.warn('using local rate-limit fallback');
    },
    onCircuitStateChange(state) {
      app.log.info({ circuitState: state }, 'Redis limiter circuit changed');
    },
  });
}

export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    ajv: { customOptions: { removeAdditional: false } },
    bodyLimit: 8192,
    logger: { level: options.config.logLevel },
  });
  const clock = options.clock ?? new SystemClock();
  const cleanupTargets: CleanupStore[] = [];
  let store = options.store;

  if (store === undefined && options.config.storeMode === 'memory') {
    const localStore = memoryStore(options.config, clock);
    cleanupTargets.push(localStore);
    store = localStore;
  } else if (store === undefined) {
    store = await redisStore(app, options.config, clock, cleanupTargets);
  } else if (isCleanupStore(store)) {
    cleanupTargets.push(store);
  }

  const limiter = new RateLimiter(
    store,
    new AdmissionController(options.config.maxInFlight),
  );
  const cleanupTimer = setInterval(() => {
    for (const target of cleanupTargets) {
      target.cleanup();
    }
  }, options.config.cleanupIntervalMs);
  cleanupTimer.unref();

  registerErrorHandler(app);
  await registerRoutes(app, { config: options.config, limiter });
  app.addHook('onClose', async () => {
    clearInterval(cleanupTimer);
    await limiter.close();
  });

  return app;
}
