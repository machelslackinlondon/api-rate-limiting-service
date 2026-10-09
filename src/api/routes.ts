import type { FastifyInstance } from 'fastify';

import type { AppConfig } from '../config/config';
import type { RateLimiter } from '../domain/rate-limiter';
import type { RateLimitCommand } from '../domain/types';
import { checkSchema } from './schemas';

export interface RegisterRoutesOptions {
  config: AppConfig;
  limiter: RateLimiter;
}

export async function registerRoutes(
  app: FastifyInstance,
  options: RegisterRoutesOptions,
): Promise<void> {
  app.post<{ Body: RateLimitCommand }>(
    '/check',
    { schema: checkSchema(options.config) },
    async (request, reply) => {
      const decision = await options.limiter.check(request.body);
      if (!decision.allowed) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((decision.retryAfterMs ?? 1) / 1000),
        );
        return reply
          .header('Retry-After', String(retryAfterSeconds))
          .code(429)
          .send(decision);
      }
      return reply.code(200).send(decision);
    },
  );

  app.get('/health', async (_request, reply) => {
    const health = options.limiter.health();
    return reply.code(health.status === 'unhealthy' ? 503 : 200).send(health);
  });
}
