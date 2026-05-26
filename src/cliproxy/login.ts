import { randomUUID } from "node:crypto";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "cliproxy.login" });

export namespace CLIProxyLogin {
  export const loginFlags: Record<string, readonly string[]> = {
    claude: ["-claude-login", "-no-browser"],
    codex: ["-codex-login", "-no-browser"],
    kimi: ["-kimi-login", "-no-browser"],
    xai: ["-xai-login", "-no-browser"],
    google: ["-login", "-no-browser"],
    antigravity: ["-antigravity-login", "-no-browser"],
  };

  export interface Job {
    readonly id: string;
    readonly provider: string;
    status: "started" | "waiting_auth" | "done" | "error" | "cancelled" | "timeout";
    oauthUrl?: string;
    callbackPort?: number;
    error?: string;
    process?: import("bun").Subprocess;
    readonly listeners: Set<(event: JobEvent) => void>;
    readonly startedAt: number;
    timeoutTimer?: ReturnType<typeof setTimeout>;
  }

  export type JobEvent =
    | { type: "started"; provider: string }
    | { type: "url"; url: string; callbackPort?: number; sshTunnel?: string }
    | { type: "done"; success: boolean }
    | { type: "error"; message: string }
    | { type: "cancelled" };

  export class LoginJobError extends Error {
    readonly name = "LoginJobError";

    constructor(readonly status: number, message: string) {
      super(message);
    }
  }

  const jobs = new Map<string, Job>();
  export const activeByProvider = new Map<string, string>();

  export function getJob(jobId: string): Job | null {
    return jobs.get(jobId) ?? null;
  }

  export function startJob(provider: string, binaryPath: string, configPath: string, timeoutMs: number): Job {
    const flags = loginFlags[provider];
    if (!flags) throw new LoginJobError(400, "unsupported provider");
    if (activeByProvider.has(provider)) throw new LoginJobError(409, "login already running for provider");

    const id = randomUUID();
    const args = [...flags];
    if (configPath) args.push("-config", configPath);

    const job: Job = {
      id,
      provider,
      status: "started",
      listeners: new Set(),
      startedAt: Date.now(),
    };
    jobs.set(id, job);
    activeByProvider.set(provider, id);

    try {
      job.process = Bun.spawn([binaryPath || "cliproxy", ...args], {
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (err) {
      failJob(job, err instanceof Error ? err.message : "failed to start login process");
      throw new LoginJobError(500, job.error ?? "failed to start login process");
    }

    job.timeoutTimer = setTimeout(() => {
      if (isTerminal(job.status)) return;
      job.status = "timeout";
      job.error = "login timed out";
      job.process?.kill();
      activeByProvider.delete(provider);
      emit(job, { type: "error", message: "login timed out" });
      logger.warn("cliproxy login timed out", { event: "cliproxy.login.timeout", provider, job_id: id });
    }, timeoutMs);

    emit(job, { type: "started", provider });
    if (job.process.stdout instanceof ReadableStream) {
      parseOutput(job, job.process.stdout).catch((err) => {
        logger.warn("cliproxy login stdout parse failed", { event: "cliproxy.login.stdout_error", err, provider, job_id: id });
      });
    }
    if (job.process.stderr instanceof ReadableStream) {
      drainStream(job.process.stderr).catch((err) => {
        logger.warn("cliproxy login stderr drain failed", { event: "cliproxy.login.stderr_error", err, provider, job_id: id });
      });
    }
    watchExit(job);
    return job;
  }

  export function cancelJob(jobId: string): boolean {
    const job = jobs.get(jobId);
    if (!job || isTerminal(job.status)) return false;
    job.status = "cancelled";
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    job.process?.kill();
    activeByProvider.delete(job.provider);
    emit(job, { type: "cancelled" });
    logger.info("cliproxy login cancelled", { event: "cliproxy.login.cancelled", provider: job.provider, job_id: job.id });
    return true;
  }

  export async function* subscribe(jobId: string): AsyncIterable<JobEvent> {
    const job = jobs.get(jobId);
    if (!job) throw new LoginJobError(404, "job not found");

    const queue: JobEvent[] = [snapshotEvent(job)];
    let notify: (() => void) | null = null;
    const listener = (event: JobEvent) => {
      queue.push(event);
      notify?.();
      notify = null;
    };

    job.listeners.add(listener);
    try {
      while (queue.length > 0 || !isTerminal(job.status)) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
        }
      }
    } finally {
      job.listeners.delete(listener);
    }
  }
}

function emit(job: CLIProxyLogin.Job, event: CLIProxyLogin.JobEvent): void {
  for (const listener of job.listeners) listener(event);
}

async function parseOutput(job: CLIProxyLogin.Job, stream: ReadableStream<Uint8Array>): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        handleLine(job, buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
  buffer += decoder.decode();
  if (buffer) handleLine(job, buffer);
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (!(await reader.read()).done) {
    }
  } finally {
    reader.releaseLock();
  }
}

function handleLine(job: CLIProxyLogin.Job, line: string): void {
  const match = /https?:\/\/[^\s"'<>]+/.exec(line);
  if (!match) return;
  const url = match[0];
  job.oauthUrl = url;
  job.callbackPort = extractCallbackPort(url);
  job.status = "waiting_auth";
  emit(job, { type: "url", url, callbackPort: job.callbackPort, sshTunnel: sshTunnel(job.callbackPort) });
}

function extractCallbackPort(oauthUrl: string): number | undefined {
  try {
    const parsed = new URL(oauthUrl);
    const redirect = parsed.searchParams.get("redirect_uri");
    if (redirect) return portFromUrl(redirect);
    return portFromUrl(oauthUrl);
  } catch {
    return undefined;
  }
}

function portFromUrl(raw: string): number | undefined {
  try {
    const parsed = new URL(raw);
    const port = Number(parsed.port);
    return Number.isInteger(port) && port > 0 ? port : undefined;
  } catch {
    return undefined;
  }
}

function sshTunnel(port: number | undefined): string | undefined {
  return port ? `ssh -L ${port}:127.0.0.1:${port} <host>` : undefined;
}

function watchExit(job: CLIProxyLogin.Job): void {
  const subprocess = job.process;
  if (!subprocess) return;
  subprocess.exited.then((code) => {
    if (isTerminal(job.status)) return;
    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
    activeProviderDelete(job);
    if (code === 0) {
      job.status = "done";
      emit(job, { type: "done", success: true });
      logger.info("cliproxy login finished", { event: "cliproxy.login.done", provider: job.provider, job_id: job.id });
      return;
    }
    failJob(job, `login process exited with code ${code}`);
  }).catch((err) => {
    if (!isTerminal(job.status)) failJob(job, err instanceof Error ? err.message : "login process failed");
  });
}

function failJob(job: CLIProxyLogin.Job, message: string): void {
  if (job.timeoutTimer) clearTimeout(job.timeoutTimer);
  job.status = "error";
  job.error = message;
  activeProviderDelete(job);
  emit(job, { type: "error", message });
  logger.warn("cliproxy login failed", { event: "cliproxy.login.error", provider: job.provider, job_id: job.id, error: message });
}

function activeProviderDelete(job: CLIProxyLogin.Job): void {
  const activeJobId = CLIProxyLogin.activeByProvider.get(job.provider);
  if (activeJobId === job.id) CLIProxyLogin.activeByProvider.delete(job.provider);
}

function isTerminal(status: CLIProxyLogin.Job["status"]): boolean {
  return status === "done" || status === "error" || status === "cancelled" || status === "timeout";
}

function snapshotEvent(job: CLIProxyLogin.Job): CLIProxyLogin.JobEvent {
  if (job.status === "waiting_auth" && job.oauthUrl) {
    return { type: "url", url: job.oauthUrl, callbackPort: job.callbackPort, sshTunnel: sshTunnel(job.callbackPort) };
  }
  if (job.status === "done") return { type: "done", success: true };
  if (job.status === "cancelled") return { type: "cancelled" };
  if (job.status === "error" || job.status === "timeout") return { type: "error", message: job.error ?? job.status };
  return { type: "started", provider: job.provider };
}
