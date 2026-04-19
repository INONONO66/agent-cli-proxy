import { randomUUID } from "crypto";
import { config } from "../../config";

const SESSION_ID = randomUUID();

function detectOS(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return "Linux";
  }
}

function detectArch(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

export function buildClaudeCodeHeaders(): Record<string, string> {
  return {
    "user-agent": `claude-cli/${config.claudeCodeVersion} (external, cli)`,
    "x-app": "cli",
    "x-claude-code-session-id": SESSION_ID,
    "x-stainless-arch": detectArch(),
    "x-stainless-os": detectOS(),
    "x-stainless-lang": "js",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "anthropic-beta":
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
    "anthropic-dangerous-direct-browser-access": "true",
  };
}
