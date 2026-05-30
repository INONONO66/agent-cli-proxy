interface OpenAICompatibleRequest {
  readonly model?: unknown;
  readonly [key: string]: unknown;
}

function normalizeModel(model: string): string {
  const prefix = "openai/";
  return model.toLowerCase().startsWith(prefix) ? model.slice(prefix.length) : model;
}

export function rewriteOpenAICompatibleRequestBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const request = body as OpenAICompatibleRequest;
  if (typeof request.model !== "string") return body;

  return {
    ...request,
    model: normalizeModel(request.model),
  };
}
