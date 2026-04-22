import { randomUUID } from "crypto";
import { identifyClient, generateClientId } from "../identification";
import { Config } from "../config";

export namespace RequestContext {
  export interface Context {
    id: string;
    startedAt: number;
    tool: string;
    clientId: string;
    provider: "anthropic" | "openai" | null;
    path: string;
    method: string;
  }

  export function create(req: Request): Context {
    const url = new URL(req.url);
    const path = url.pathname;
    let provider: "anthropic" | "openai" | null = null;
    if (path === "/v1/messages") provider = "anthropic";
    else if (path === "/v1/chat/completions") provider = "openai";

    const identity = identifyClient(req.headers);

    const apiKey = req.headers.get("authorization")?.replace("Bearer ", "").trim();
    const customName = apiKey ? Config.clientNameMapping.get(apiKey) : undefined;
    if (customName) {
      identity.customName = customName;
    }

    const clientId = generateClientId(identity);

    return {
      id: randomUUID(),
      startedAt: Date.now(),
      tool: identity.tool,
      clientId,
      provider,
      path,
      method: req.method,
    };
  }
}
