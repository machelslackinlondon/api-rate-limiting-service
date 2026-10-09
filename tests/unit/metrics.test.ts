import { describe, expect, test } from '@jest/globals';

import { LimiterMetrics } from '../../src/metrics/metrics';

describe('LimiterMetrics', () => {
  test('renders required decision, latency, fallback, error, and state metrics', async () => {
    const metrics = new LimiterMetrics({ activeClients: () => 3 });

    metrics.observeDecision(
      { allowed: true, remaining: 1, resetAt: 2000, mode: 'memory' },
      0.004,
    );
    metrics.observeDecision(
      {
        allowed: false,
        remaining: 0,
        resetAt: 2000,
        retryAfterMs: 500,
        mode: 'fallback',
      },
      0.008,
    );
    metrics.observeStoreError(new Error('Redis timeout'));
    metrics.observeOverload();
    metrics.observeFallback();
    metrics.setCircuitState('open');

    const output = await metrics.render();
    expect(output).toContain(
      'rate_limiter_requests_total{mode="memory",outcome="allowed"} 1',
    );
    expect(output).toContain('rate_limiter_allowed_total{mode="memory"} 1');
    expect(output).toContain('rate_limiter_rejected_total{mode="fallback"} 1');
    expect(output).toContain('rate_limiter_latency_seconds_count');
    expect(output).toContain('rate_limiter_store_errors_total{category="error"} 1');
    expect(output).toContain('rate_limiter_overload_rejections_total 1');
    expect(output).toContain('rate_limiter_fallback_total 1');
    expect(output).toContain('rate_limiter_circuit_state 1');
    expect(output).toContain('rate_limiter_active_clients 3');
    expect(output).toContain('process_cpu_user_seconds_total');
  });

  test('uses the Prometheus content type', () => {
    const metrics = new LimiterMetrics({ activeClients: () => 0 });
    expect(metrics.contentType).toContain('text/plain');
  });
});
