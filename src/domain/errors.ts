import type { RateLimitPolicy } from './types';

export abstract class DomainError extends Error {
  protected constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 400);
  }
}

export class PolicyConflictError extends DomainError {
  constructor(readonly activePolicy: RateLimitPolicy) {
    super(
      'limit and windowMs must match the active client policy',
      'POLICY_CONFLICT',
      409,
    );
  }
}

export class CapacityError extends DomainError {
  constructor(message = 'rate limiter state capacity is exhausted') {
    super(message, 'CAPACITY_EXHAUSTED', 503);
  }
}

export class OverloadedError extends DomainError {
  constructor() {
    super('rate limiter processing capacity is exhausted', 'OVERLOADED', 503);
  }
}

export class StoreUnavailableError extends DomainError {
  constructor(message = 'rate limiter store is unavailable') {
    super(message, 'STORE_UNAVAILABLE', 503);
  }
}
