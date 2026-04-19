import type { RequestContext } from "./requestContext";
import type { TokenUsage } from "../types/index";

type RequestHandler = (
  req: Request,
  ctx: RequestContext,
  onUsage?: (usage: TokenUsage) => void
) => Promise<Response>;

export function withUsageLogging(
  handler: RequestHandler
): (req: Request, ctx: RequestContext) => Promise<Response> {
  return async (req: Request, ctx: RequestContext): Promise<Response> => {
    let model = "unknown";
    try {
      const parsed = (await req.clone().json()) as Record<string, unknown>;
      if (typeof parsed.model === "string") model = parsed.model;
    } catch {}

    const startedAt = new Date(ctx.startedAt).toISOString();
    let responseStatus = 0;
    let isStreaming = false;

    const onUsage = async (usage: TokenUsage): Promise<void> => {
      try {
        const { usageService } = await import("../services/index");
        await usageService.recordUsage({
          provider: ctx.provider ?? "unknown",
          model,
          path: ctx.path,
          streamed: isStreaming ? 1 : 0,
          status: responseStatus,
          prompt_tokens: usage.prompt_tokens,
          completion_tokens: usage.completion_tokens,
          cache_creation_tokens: usage.cache_creation_tokens,
          cache_read_tokens: usage.cache_read_tokens,
          total_tokens: usage.total_tokens,
          cost_usd: 0,
          incomplete: usage.incomplete ? 1 : 0,
          latency_ms: Date.now() - ctx.startedAt,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        });
      } catch (err) {
        console.error("[logUsage] failed to record usage:", err);
      }
    };

    let response: Response;
    try {
      response = await handler(req, ctx, onUsage);
      responseStatus = response.status;
      isStreaming =
        response.headers.get("content-type")?.includes("text/event-stream") ??
        false;
    } catch (err) {
      try {
        const { usageService } = await import("../services/index");
        await usageService.recordUsage({
          provider: ctx.provider ?? "unknown",
          model,
          path: ctx.path,
          streamed: 0,
          status: 500,
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          total_tokens: 0,
          cost_usd: 0,
          incomplete: 1,
          error_code: "internal_error",
          latency_ms: Date.now() - ctx.startedAt,
          started_at: startedAt,
          finished_at: new Date().toISOString(),
        });
      } catch {}
      throw err;
    }

    if (!isStreaming && responseStatus >= 400) {
      await onUsage({
        prompt_tokens: 0,
        completion_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        total_tokens: 0,
        incomplete: true,
      });
    }

    return response;
  };
}
