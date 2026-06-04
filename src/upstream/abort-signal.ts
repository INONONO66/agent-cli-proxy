export interface ComposedAbortSignal {
  readonly signal: AbortSignal;
  cleanup: () => void;
}

export function composeAbortSignals(signals: readonly (AbortSignal | undefined)[]): ComposedAbortSignal {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return { signal: new AbortController().signal, cleanup: noop };
  }
  if (active.length === 1) {
    return { signal: active[0], cleanup: noop };
  }

  const abortSignal = AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
  if (typeof abortSignal.any === "function") {
    return { signal: abortSignal.any(active), cleanup: noop };
  }

  const controller = new AbortController();
  const listeners: Array<{ signal: AbortSignal; listener: () => void }> = [];
  let cleaned = false;

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    for (const entry of listeners) {
      entry.signal.removeEventListener("abort", entry.listener);
    }
    listeners.length = 0;
  }

  function abort(signal: AbortSignal): void {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  }

  for (const signal of active) {
    if (signal.aborted) {
      abort(signal);
      break;
    }
    const listener = (): void => {
      abort(signal);
      cleanup();
    };
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }

  return { signal: controller.signal, cleanup };
}

function noop(): void {}
