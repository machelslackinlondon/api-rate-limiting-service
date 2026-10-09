import { describe, expect, test } from '@jest/globals';

import { AdmissionController } from '../../src/domain/admission-controller';

describe('AdmissionController', () => {
  test('rejects immediately instead of queueing above the in-flight limit', async () => {
    const gate = new AdmissionController(1);
    let release: (() => void) | undefined;
    const first = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    await expect(gate.run(async () => undefined)).rejects.toMatchObject({
      code: 'OVERLOADED',
    });
    expect(gate.inFlight).toBe(1);

    release?.();
    await first;
    expect(gate.inFlight).toBe(0);
  });

  test('releases capacity when the admitted operation rejects', async () => {
    const gate = new AdmissionController(1);

    await expect(
      gate.run(async () => {
        throw new Error('operation failed');
      }),
    ).rejects.toThrow('operation failed');

    expect(gate.inFlight).toBe(0);
    await expect(gate.run(async () => 'accepted')).resolves.toBe('accepted');
  });
});
