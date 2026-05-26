import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { CLIProxyLogin } from "../../src/cliproxy/login";

const spawnedJobs: string[] = [];

function makeProcess(): Bun.Subprocess {
  return {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
    exited: Promise.resolve(0),
    kill: () => {},
  } as Bun.Subprocess;
}

afterEach(() => {
  for (const jobId of spawnedJobs.splice(0)) {
    CLIProxyLogin.cancelJob(jobId);
  }
  CLIProxyLogin.activeByProvider.clear();
});

describe("CLIProxyLogin", () => {
  test("startJob rejects unknown providers", () => {
    expect(() => CLIProxyLogin.startJob("unknown", "cliproxy", "", 1_000)).toThrowError(CLIProxyLogin.LoginJobError);
  });

  test("startJob rejects duplicate active jobs per provider", () => {
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue(makeProcess());
    try {
      const job = CLIProxyLogin.startJob("claude", "cliproxy", "", 1_000);
      spawnedJobs.push(job.id);

      expect(() => CLIProxyLogin.startJob("claude", "cliproxy", "", 1_000)).toThrowError(CLIProxyLogin.LoginJobError);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  test("cancelJob returns false for missing job ids", () => {
    expect(CLIProxyLogin.cancelJob("missing-job-id")).toBe(false);
  });

  test("loginFlags covers supported providers and disables browser launch", () => {
    expect(Object.keys(CLIProxyLogin.loginFlags).sort()).toEqual([
      "antigravity",
      "claude",
      "codex",
      "google",
      "kimi",
      "xai",
    ]);

    for (const flags of Object.values(CLIProxyLogin.loginFlags)) {
      expect(flags).toContain("-no-browser");
    }
  });
});
