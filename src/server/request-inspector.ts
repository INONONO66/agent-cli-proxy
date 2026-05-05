export interface RequestInfo {
  model: string | null;
  agentName: string | null;
  userAgent: string | null;
  originator: string | null;
  sessionId: string | null;
  apiKey: string | null;
  isStreaming: boolean;
  path: string;
  method: string;
  clientIp: string | null;
  requestId?: string;
}

export class RequestBodyTooLargeError extends Error {
  readonly name = "RequestBodyTooLargeError";
  readonly code = "REQUEST_BODY_TOO_LARGE";

  constructor(readonly limit: number) {
    super(`request body exceeds ${limit} bytes`);
  }
}

export function isRequestBodyTooLargeError(err: unknown): err is RequestBodyTooLargeError {
  if (!(err instanceof Error)) return false;
  if (err instanceof RequestBodyTooLargeError) return true;
  if (err.name === "RequestBodyTooLargeError") return true;
  return err.message.startsWith("request body exceeds ") && err.message.endsWith(" bytes");
}

export namespace RequestInspector {
  export async function inspect(req: Request): Promise<RequestInfo> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    const userAgent = req.headers.get("user-agent");
    const agentName = req.headers.get("x-agent-name");
    const originator = req.headers.get("originator");
    const sessionId = req.headers.get("x-opencode-session")
      || req.headers.get("x-openclaw-session-id")
      || req.headers.get("x-activity-request-id");
    const apiKey = req.headers.get("authorization")?.replace("Bearer ", "").trim()
      || req.headers.get("x-api-key");

    const forwarded = req.headers.get("x-forwarded-for");
    const clientIp = forwarded
      ? forwarded.split(",")[0]?.trim()
      : null;

    let model: string | null = null;
    let isStreaming = false;

    if (method === "POST" && (path === "/v1/messages" || path === "/v1/chat/completions")) {
      try {
        const cloned = req.clone();
        const body = await cloned.json() as Record<string, unknown>;
        if (typeof body.model === "string") {
          model = body.model;
        }
        if (body.stream === true || body.stream === "true") {
          isStreaming = true;
        }
      } catch (err) {
        if (isRequestBodyTooLargeError(err)) throw err;
        // Body is not JSON or already consumed; treat as opaque pass-through.
        // model/streaming detection is best-effort here.
      }
    }

    return {
      model,
      agentName,
      userAgent,
      originator,
      sessionId,
      apiKey,
      isStreaming,
      path,
      method,
      clientIp,
    };
  }

  export function isClaudeModel(model: string | null): boolean {
    return !!model && model.startsWith("claude");
  }

  export function detectTool(info: RequestInfo): string {
    if (info.agentName) {
      return info.agentName;
    }

    if (info.userAgent) {
      const ua = info.userAgent.toLowerCase();
      if (ua.includes("opencode")) return "opencode";
      if (ua.includes("openclaw")) return "openclaw";
      if (ua.includes("hermes")) return "hermes-agent";
      if (ua.includes("anthropic")) return "anthropic-sdk";
    }

    if (info.originator) {
      return info.originator.toLowerCase();
    }

    if (info.sessionId) {
      if (info.sessionId.startsWith("opencode-")) return "opencode";
      if (info.sessionId.startsWith("openclaw-")) return "openclaw";
    }

    return "unknown";
  }

  export function generateClientId(tool: string, info: RequestInfo): string {
    const parts = [tool];

    if (info.agentName) {
      parts.push(info.agentName);
    } else if (info.sessionId) {
      parts.push(info.sessionId.slice(0, 8));
    } else if (info.apiKey) {
      parts.push(info.apiKey.slice(0, 8));
    }

    return parts.join("-");
  }
}
