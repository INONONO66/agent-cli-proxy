export type LoopState = {
  name: string;
  failed: boolean;
  consecutiveFailures: number;
  lastSuccessAt: number | null;
  lastErrorAt: number | null;
  maxConsecutiveFailures: number;
  controller: AbortController;
  done: Promise<void>;
  stopRequested: boolean;
  stopLogged: boolean;
  stop(timeoutMs: number): Promise<void>;
};
