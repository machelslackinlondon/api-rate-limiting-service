import type { FastifySchema } from 'fastify';

import type { AppConfig } from '../config/config';

export function checkSchema(config: AppConfig): FastifySchema {
  return {
    body: {
      type: 'object',
      additionalProperties: false,
      required: ['clientId', 'limit', 'windowMs'],
      properties: {
        clientId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          pattern: '^[A-Za-z0-9._:-]+$',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: config.maxLimit,
        },
        windowMs: {
          type: 'integer',
          minimum: config.minWindowMs,
          maximum: config.maxWindowMs,
        },
      },
    },
  };
}
