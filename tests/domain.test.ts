import { describe, expect, it } from 'vitest';
import { accountStatuses, canTransition, isTerminal } from '../packages/shared/src/index.js';
import { resolveSteps } from '../apps/api/src/routes.js';

describe('account lifecycle', () => {
  it('matches the terminal and idle transition rules', () => {
    expect(accountStatuses.filter((to) => canTransition('idle', to))).toEqual([
      'online',
      'suspended',
      'session_expired',
    ]);
    expect(accountStatuses.filter((to) => canTransition('suspended', to))).toEqual([]);
    expect(accountStatuses.filter((to) => canTransition('session_expired', to))).toEqual([]);
    expect(isTerminal('suspended')).toBe(true);
    expect(isTerminal('online')).toBe(false);
  });
});

describe('sequence variable resolution', () => {
  const steps = [
    { index: 1, accountRole: 'admin', text: '{event} at {time}', delaySeconds: 1 },
    { index: 2, accountRole: 'member', text: '{event} in {location}', delaySeconds: 2 },
    { index: 3, accountRole: 'member', text: '{event} remains in {location}', delaySeconds: 3 },
  ];

  it('carries step overrides forward and records the original source', () => {
    const result = resolveSteps(
      steps,
      { event: 'Demo', time: '10:00', location: 'A' },
      { '2': { location: 'B' }, '3': { location: '' } },
    );
    expect(result[1].resolvedText).toBe('Demo in B');
    expect(result[2].resolvedText).toBe('Demo remains in B');
    expect(result[2].varSources.location).toBe('step:2');
  });

  it('reports the first unresolved step and key', () => {
    expect(() => resolveSteps(steps, { event: 'Demo' }, {})).toThrowError(
      expect.objectContaining({
        code: 'UNRESOLVED_PLACEHOLDER',
        details: { stepIndex: 1, key: 'time' },
      }),
    );
  });
});
