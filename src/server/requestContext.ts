import { randomUUID } from "crypto";

export interface RequestContext {
  id: string;
  startedAt: number;
  provider: "anthropic" | "openai" | null;
  path: string;
  method: string;
  agent: string | null;
}

export function createRequestContext(req: Request): RequestContext {
  const url = new URL(req.url);
  const path = url.pathname;
  let provider: "anthropic" | "openai" | null = null;
  if (path === "/v1/messages") provider = "anthropic";
  else if (path === "/v1/chat/completions") provider = "openai";
  return {
    id: randomUUID(),
    startedAt: Date.now(),
    provider,
    path,
    method: req.method,
    agent: req.headers.get("x-agent-name") ?? null,
  };
}
