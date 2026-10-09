import { PolicyConflictError, StoreUnavailableError } from '../domain/errors';
import type { RateLimitDecision } from '../domain/types';

export const SLIDING_WINDOW_SCRIPT = `
local nowParts = redis.call('TIME')
local now = (tonumber(nowParts[1]) * 1000) + math.floor(tonumber(nowParts[2]) / 1000)
local requestedLimit = tonumber(ARGV[1])
local requestedWindow = tonumber(ARGV[2])
local requestId = ARGV[3]

local active = redis.call('HMGET', KEYS[1], 'limit', 'windowMs')
local activeLimit = tonumber(active[1])
local activeWindow = tonumber(active[2])

if activeLimit and activeWindow then
  local cutoff = now - activeWindow
  redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', cutoff)
  local activeCount = redis.call('ZCARD', KEYS[2])

  if activeCount == 0 then
    redis.call('DEL', KEYS[1], KEYS[2])
    activeLimit = nil
    activeWindow = nil
  elseif activeLimit ~= requestedLimit or activeWindow ~= requestedWindow then
    return {-1, 0, 0, now, activeLimit, activeWindow}
  end
else
  redis.call('DEL', KEYS[2])
end

if not activeLimit then
  redis.call('HSET', KEYS[1], 'limit', requestedLimit, 'windowMs', requestedWindow)
  activeLimit = requestedLimit
  activeWindow = requestedWindow
end

local count = redis.call('ZCARD', KEYS[2])
local allowed = 0
if count < requestedLimit then
  redis.call('ZADD', KEYS[2], now, requestId)
  count = count + 1
  allowed = 1
end

redis.call('PEXPIRE', KEYS[1], requestedWindow)
redis.call('PEXPIRE', KEYS[2], requestedWindow)

local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
local resetAt = tonumber(oldest[2]) + requestedWindow
local remaining = requestedLimit - count
if remaining < 0 then
  remaining = 0
end

return {allowed, remaining, resetAt, now, 0, 0}
`;

function numericTuple(reply: unknown): number[] {
  if (!Array.isArray(reply) || reply.length !== 6) {
    throw new StoreUnavailableError('Redis returned a malformed limiter reply');
  }

  const tuple = reply.map((value) => Number(value));
  if (tuple.some((value) => !Number.isSafeInteger(value))) {
    throw new StoreUnavailableError('Redis returned a malformed limiter reply');
  }
  return tuple;
}

export function decodeRedisDecision(reply: unknown): RateLimitDecision {
  const tuple = numericTuple(reply);
  const [status, remaining, resetAt, now, activeLimit, activeWindowMs] = tuple;

  if (
    status === undefined ||
    remaining === undefined ||
    resetAt === undefined ||
    now === undefined ||
    activeLimit === undefined ||
    activeWindowMs === undefined
  ) {
    throw new StoreUnavailableError('Redis returned a malformed limiter reply');
  }

  if (status === -1) {
    throw new PolicyConflictError({
      limit: activeLimit,
      windowMs: activeWindowMs,
    });
  }

  if (status === 1) {
    return {
      allowed: true,
      remaining,
      resetAt,
      mode: 'redis',
    };
  }

  if (status === 0) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
      retryAfterMs: Math.max(1, resetAt - now),
      mode: 'redis',
    };
  }

  throw new StoreUnavailableError('Redis returned a malformed limiter reply');
}
