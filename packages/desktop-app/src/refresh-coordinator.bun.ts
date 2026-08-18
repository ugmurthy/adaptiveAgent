import { describe, expect, test } from 'bun:test';
import { createRefreshCoordinator } from './refresh-coordinator';

describe('refresh coordinator', () => {
  test('coalesces sustained events into one in-flight and one trailing pass', async () => {
    let release!: () => void;
    let active = 0;
    let maximumActive = 0;
    let passes = 0;
    const firstPass = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createRefreshCoordinator(async () => {
      passes += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (passes === 1) await firstPass;
      active -= 1;
    });

    const initial = coordinator.request();
    await Promise.resolve();
    const eventOne = coordinator.request();
    const eventTwo = coordinator.request();
    const eventThree = coordinator.request();
    expect(passes).toBe(1);
    release();
    await Promise.all([initial, eventOne, eventTwo, eventThree]);

    expect(passes).toBe(2);
    expect(maximumActive).toBe(1);
  });

  test('does not start a trailing pass after disposal', async () => {
    let release!: () => void;
    let passes = 0;
    const firstPass = new Promise<void>((resolve) => { release = resolve; });
    const coordinator = createRefreshCoordinator(async () => {
      passes += 1;
      await firstPass;
    });

    const refresh = coordinator.request();
    await Promise.resolve();
    void coordinator.request();
    coordinator.dispose();
    release();
    await refresh;

    expect(passes).toBe(1);
  });
});
