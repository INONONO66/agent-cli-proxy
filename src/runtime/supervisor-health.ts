type LoopHealthStatus = "pass" | "warn" | "fail";

export interface LoopStateInput {
  readonly name: string;
  readonly failed: boolean;
  readonly consecutiveFailures: number;
  readonly lastSuccessAt: number | null;
  readonly lastErrorAt: number | null;
}

export interface LoopHealthSnapshot {
  readonly name: string;
  readonly lastSuccessAgeMs?: number;
  readonly lastErrorAgeMs?: number;
  readonly consecutiveFailures: number;
  readonly status: LoopHealthStatus;
}

export type LoopStatus = {
  readonly name: string;
  readonly failed: boolean;
  readonly consecutiveFailures: number;
};

export function compareLoopName(left: { readonly name: string }, right: { readonly name: string }): number {
  return left.name.localeCompare(right.name);
}

export function toLoopStatus(state: LoopStateInput): LoopStatus {
  return {
    name: state.name,
    failed: state.failed,
    consecutiveFailures: state.consecutiveFailures,
  };
}

function loopHealthStatus(state: LoopStateInput): LoopHealthStatus {
  if (state.failed) return "fail";
  if (state.consecutiveFailures > 0) return "warn";
  return "pass";
}

export function toLoopHealthSnapshot(state: LoopStateInput, nowMs: number): LoopHealthSnapshot {
  const snapshot: LoopHealthSnapshot = {
    name: state.name,
    consecutiveFailures: state.consecutiveFailures,
    status: loopHealthStatus(state),
  };
  if (state.lastSuccessAt !== null) {
    return {
      ...snapshot,
      lastSuccessAgeMs: Math.max(0, nowMs - state.lastSuccessAt),
      ...(state.lastErrorAt === null ? {} : { lastErrorAgeMs: Math.max(0, nowMs - state.lastErrorAt) }),
    };
  }
  if (state.lastErrorAt !== null) {
    return {
      ...snapshot,
      lastErrorAgeMs: Math.max(0, nowMs - state.lastErrorAt),
    };
  }
  return snapshot;
}
