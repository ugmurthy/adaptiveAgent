export interface RefreshCoordinator {
  request(): Promise<void>;
  dispose(): void;
}

export function createRefreshCoordinator(run: () => Promise<void>): RefreshCoordinator {
  let requested = false;
  let disposed = false;
  let running: Promise<void> | undefined;

  async function drain(): Promise<void> {
    try {
      while (requested && !disposed) {
        requested = false;
        await run();
      }
    } finally {
      running = undefined;
      if (requested && !disposed) running = drain();
    }
  }

  return {
    request() {
      if (disposed) return Promise.resolve();
      requested = true;
      running ??= drain();
      return running;
    },
    dispose() {
      disposed = true;
      requested = false;
    },
  };
}
