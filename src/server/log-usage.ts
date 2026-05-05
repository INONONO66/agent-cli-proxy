import type { TokenUsage } from "../usage";
import type { RequestContext } from "./request-context";
import { Logger } from "../util/logger";

const logger = Logger.fromConfig().child({ component: "log-usage" });

type RequestHandler = (
  req: Request,
  ctx: RequestContext.Context,
  onUsage?: (usage: TokenUsage) => void,
) => Promise<Response>;

export namespace LogUsage {
  export function withLogging(handler: RequestHandler): RequestHandler {
    return async (req, ctx, _onUsageCallback) => {
      let model = "unknown";
      let rawBody: Record<string, unknown> | undefined;
      try {
        rawBody = (await req.clone().json()) as Record<string, unknown>;
        if (typeof rawBody.model === "string") model = rawBody.model;
        logger.info("request received", { request_id: ctx.id, tool: ctx.tool, client_id: ctx.clientId, model, path: ctx.path });
        logger.debug("request body parsed", { request_id: ctx.id, body: rawBody });
      } catch (err) {
        logger.info("request received", { request_id: ctx.id, tool: ctx.tool, client_id: ctx.clientId, path: ctx.path, body_parse_failed: true, err });
      }

      const userAgent = req.headers.get("user-agent") ?? undefined;
      const sourceIp =
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined;

      const startedAt = new Date(ctx.startedAt).toISOString();
      let responseStatus = 0;
      let isStreaming = false;

      const onUsage = async (usage: TokenUsage): Promise<void> => {
        try {
          const { usageService } = await import("../storage");
          await usageService.recordUsage({
            request_id: ctx.id,
            provider: ctx.provider ?? "unknown",
            model,
            tool: ctx.tool,
            client_id: ctx.clientId,
            path: ctx.path,
            streamed: isStreaming ? 1 : 0,
            status: responseStatus,
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            reasoning_tokens: usage.reasoning_tokens ?? 0,
            total_tokens: usage.total_tokens,
            cost_usd: 0,
            incomplete: usage.incomplete ? 1 : 0,
            latency_ms: Date.now() - ctx.startedAt,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            user_agent: userAgent,
            source_ip: sourceIp,
          });
        } catch (err) {
          logger.error("failed to record usage", { err, request_id: ctx.id, path: ctx.path });
        }
      };

      let response: Response;
      try {
        response = await handler(req, ctx, onUsage);
        responseStatus = response.status;
        isStreaming = response.headers.get("content-type")?.includes("text/event-stream") ?? false;
      } catch (err) {
        try {
          const { usageService } = await import("../storage");
          await usageService.recordUsage({
            request_id: ctx.id,
            provider: ctx.provider ?? "unknown",
            model,
            tool: ctx.tool,
            client_id: ctx.clientId,
            path: ctx.path,
            streamed: 0,
            status: 500,
            prompt_tokens: 0,
            completion_tokens: 0,
            cache_creation_tokens: 0,
            cache_read_tokens: 0,
            reasoning_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            incomplete: 1,
            error_code: "internal_error",
            latency_ms: Date.now() - ctx.startedAt,
            started_at: startedAt,
            finished_at: new Date().toISOString(),
            user_agent: userAgent,
            source_ip: sourceIp,
          });
        } catch (logErr) {
          logger.error("failed to record error usage", { err: logErr, request_id: ctx.id, path: ctx.path });
        }
        throw err;
      }

      if (!isStreaming && responseStatus >= 400) {
        await onUsage({
          prompt_tokens: 0,
          completion_tokens: 0,
          cache_creation_tokens: 0,
          cache_read_tokens: 0,
          reasoning_tokens: 0,
          total_tokens: 0,
          incomplete: true,
        });
      }

      return response;
    };
  }
}
