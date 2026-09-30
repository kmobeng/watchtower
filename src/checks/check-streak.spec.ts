import { evaluateStreak } from './check-streak';

describe('evaluateStreak', () => {
  const F = { isUp: false };
  const U = { isUp: true };

  it('is up with no failures', async () => {
    expect(evaluateStreak([U, F, F], 3)).toEqual({
      state: 'up',
      consecutiveFailures: 0,
    });
  });

  it('is suspicious below the threshold', async () => {
    expect(evaluateStreak([F], 3)).toEqual({
      state: 'suspicious',
      consecutiveFailures: 1,
    });
    expect(evaluateStreak([F, F, U], 3)).toEqual({
      state: 'suspicious',
      consecutiveFailures: 2,
    });
  });

  it('flips to down at the threshold and stays down past it', async () => {
    expect(evaluateStreak([F, F, F], 3)).toEqual({
      state: 'down',
      consecutiveFailures: 3,
    });
    expect(evaluateStreak([F, F, F, F], 3)).toEqual({
      state: 'down',
      consecutiveFailures: 4,
    });
  });

  it('counts only leading failures, not totals in the window', async () => {
    // Two old failures behind a success must not count.
    expect(evaluateStreak([U, F, F], 3)).toEqual({
      state: 'up',
      consecutiveFailures: 0,
    });
    expect(evaluateStreak([F, U, F, F], 3)).toEqual({
      state: 'suspicious',
      consecutiveFailures: 1,
    });
  });

  it('treats any failure as down when threshold is 1', async () => {
    expect(evaluateStreak([F], 1)).toEqual({
      state: 'down',
      consecutiveFailures: 1,
    });
    expect(evaluateStreak([U], 1)).toEqual({
      state: 'up',
      consecutiveFailures: 0,
    });
  });

  it('defaults empty history to up', async () => {
    expect(evaluateStreak([], 3)).toEqual({
      state: 'up',
      consecutiveFailures: 0,
    });
  });
});
