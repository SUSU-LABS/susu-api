import { afterEach, describe, expect, it, vi } from 'vitest';
import { startNotificationSweep } from './server';
import type { NotificationSweeper, SweepResult } from './db/notification-sweep';

/** A sweeper that only records calls — derivation itself is tested elsewhere. */
function fakeSweeper(result: SweepResult = { events: 0, written: 0, rounds: 0 }) {
  const calls: number[] = [];
  const sweeper: NotificationSweeper = {
    sweep: async () => {
      calls.push(calls.length);
      return result;
    },
  };
  return { sweeper, calls };
}

const log = { info: vi.fn(), warn: vi.fn() };

describe('startNotificationSweep', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('sweeps on the interval so a pg_cron-less database still derives', async () => {
    vi.useFakeTimers();
    const { sweeper, calls } = fakeSweeper();
    startNotificationSweep(sweeper, log, 1000);

    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.length).toBe(3);
  });

  it('logs a failure and keeps running rather than crashing', async () => {
    vi.useFakeTimers();
    let n = 0;
    const sweeper: NotificationSweeper = {
      sweep: async () => {
        n += 1;
        if (n === 1) throw new Error('db unreachable');
        return { events: 0, written: 0, rounds: 0 };
      },
    };
    startNotificationSweep(sweeper, log, 1000);

    await vi.advanceTimersByTimeAsync(3000);
    expect(n).toBe(3);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'notification_sweep_failed' }),
      'notification sweep failed',
    );
  });

  it('stops sweeping once the interval is cleared', async () => {
    vi.useFakeTimers();
    const { sweeper, calls } = fakeSweeper();
    const timer = startNotificationSweep(sweeper, log, 1000);

    await vi.advanceTimersByTimeAsync(2000);
    clearInterval(timer); // what app.close() does
    await vi.advanceTimersByTimeAsync(3000);
    expect(calls.length).toBe(2);
  });
});
