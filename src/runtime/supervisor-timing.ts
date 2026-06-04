export function applyJitter(delayMs: number, jitterRatio: number): number {
  if (delayMs <= 0 || jitterRatio <= 0) return Math.max(0, Math.round(delayMs));
  const spread = delayMs * jitterRatio;
  const offset = (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(delayMs + offset));
}

export function sleep(delayMs: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const onAbort = () => {
      if (timeout) clearTimeout(timeout);
      resolve(false);
    };
    timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export async function resolveWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
