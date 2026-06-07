import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import type { OutgoingHttpHeaders } from "node:http";
import { Config } from "../config";
import { CanonicalProvider } from "../provider/canonical";
import { ProviderRegistry } from "../provider/registry";
import type { ProviderDefinition } from "../provider/registry-schema";
import { Logger } from "../util/logger";
import { PassThroughProxy, type ProxyAuthContext } from "./pass-through";
import type { RequestInfo } from "./request-inspector";

const logger = Logger.fromConfig().child({ component: "websocket-proxy" });

type RelayMessage = string | ArrayBuffer | Uint8Array;

interface ResolvedUpstream {
  readonly provider: ProviderDefinition;
  readonly url: string;
}

export interface WebSocketProxyData {
  readonly upstream: WebSocket;
  readonly path: string;
  readonly providerId: string;
  readonly requestId: string;
  readonly queue: RelayMessage[];
  isClientOpen: boolean;
  isUpstreamOpen: boolean;
  isClosing: boolean;
}

export namespace WebSocketProxy {
  export type Data = WebSocketProxyData;
  export type ServerContext = Pick<Server<Data>, "requestIP"> & Partial<Pick<Server<Data>, "upgrade">>;

  export const handler: WebSocketHandler<Data> = {
    open(ws) {
      const data = ws.data;
      data.isClientOpen = true;
      wireUpstream(ws, data);
    },

    message(ws, message) {
      const data = ws.data;
      const relayMessage = normalizeRelayMessage(message);
      if (data.isUpstreamOpen) {
        data.upstream.send(relayMessage);
        return;
      }
      data.queue.push(relayMessage);
    },

    close(ws, code, reason) {
      const data = ws.data;
      data.isClientOpen = false;
      closeUpstream(data, code, reason);
    },
  };

  export function isUpgradeRequest(req: Request): boolean {
    return req.headers.get("upgrade")?.toLowerCase() === "websocket";
  }

  export function upgrade(req: Request, context: ServerContext | undefined, info: RequestInfo, authContext: ProxyAuthContext): Response {
    if (!context?.upgrade) {
      return new Response(JSON.stringify({ error: "WebSocket upgrade unavailable" }), {
        status: 501,
        headers: { "content-type": "application/json" },
      });
    }

    const resolved = resolveUpstream(info);
    if (authContext.mode === "resolved" && !isProviderAllowed(resolved.provider.id, authContext.proxyApiKey.allowedProviders)) {
      return new Response(JSON.stringify({ error: "provider not allowed for this API key" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }

    const url = appendSearch(toWebSocketUrl(resolved.url), new URL(req.url).search);
    const BunWebSocket = WebSocket as unknown as { new(url: string | URL, options?: Bun.WebSocketOptions): WebSocket };
    const upstream = new BunWebSocket(url, {
      headers: buildUpstreamHeaders(req.headers, info, resolved.provider),
      protocols: requestedProtocols(req.headers),
    });
    upstream.binaryType = "arraybuffer";

    const data: Data = {
      upstream,
      path: info.path,
      providerId: resolved.provider.id,
      requestId: crypto.randomUUID(),
      queue: [],
      isClientOpen: false,
      isUpstreamOpen: false,
      isClosing: false,
    };

    const upgraded = context.upgrade(req, {
      data,
      headers: upgradeResponseHeaders(req.headers),
    });
    if (upgraded) return new Response(null, { status: 101 });

    upstream.close(1011, "upgrade failed");
    return new Response(JSON.stringify({ error: "WebSocket upgrade failed" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  function wireUpstream(ws: ServerWebSocket<Data>, data: Data): void {
    data.upstream.addEventListener("open", () => {
      data.isUpstreamOpen = true;
      for (const message of data.queue.splice(0)) {
        data.upstream.send(message);
      }
      logger.info("websocket upstream connected", {
        event: "websocket.upstream_connected",
        request_id: data.requestId,
        path: data.path,
        provider: data.providerId,
      });
    });

    data.upstream.addEventListener("message", (event) => {
      if (!data.isClientOpen) return;
      const message = normalizeRelayMessage(event.data);
      ws.send(message);
    });

    data.upstream.addEventListener("close", (event) => {
      data.isUpstreamOpen = false;
      closeClient(ws, data, event.code, event.reason);
    });

    data.upstream.addEventListener("error", () => {
      logger.warn("websocket upstream error", {
        event: "websocket.upstream_error",
        request_id: data.requestId,
        path: data.path,
        provider: data.providerId,
      });
      closeClient(ws, data, 1011, "upstream websocket error");
    });
  }

  function closeClient(ws: ServerWebSocket<Data>, data: Data, code: number, reason: string): void {
    if (data.isClosing) return;
    data.isClosing = true;
    if (data.isClientOpen) ws.close(code || 1000, reason);
  }

  function closeUpstream(data: Data, code: number, reason: string): void {
    if (data.isClosing) return;
    data.isClosing = true;
    if (data.upstream.readyState === WebSocket.OPEN || data.upstream.readyState === WebSocket.CONNECTING) {
      data.upstream.close(code || 1000, reason);
    }
  }

  function buildUpstreamHeaders(headers: Headers, info: RequestInfo, provider: ProviderDefinition): OutgoingHttpHeaders {
    const result = PassThroughProxy.buildHeaders(headers, info, provider);
    for (const name of Array.from(result.keys())) {
      const lower = name.toLowerCase();
      if (lower === "connection" || lower === "upgrade" || lower.startsWith("sec-websocket-")) {
        result.delete(name);
      }
    }

    const out: OutgoingHttpHeaders = {};
    for (const [key, value] of result.entries()) {
      out[key] = value;
    }
    return out;
  }

  function upgradeResponseHeaders(headers: Headers): HeadersInit | undefined {
    const protocols = requestedProtocols(headers);
    if (protocols.length === 0) return undefined;
    return { "sec-websocket-protocol": protocols[0] ?? "" };
  }

  function requestedProtocols(headers: Headers): string[] {
    return (headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((protocol) => protocol.trim())
      .filter((protocol) => protocol.length > 0);
  }

  function normalizeRelayMessage(message: unknown): RelayMessage {
    if (typeof message === "string") return message;
    if (message instanceof ArrayBuffer) return message;
    if (ArrayBuffer.isView(message)) return new Uint8Array(message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength));
    return String(message);
  }

  function resolveUpstream(info: RequestInfo): ResolvedUpstream {
    const provider = ProviderRegistry.resolve({ path: info.path, model: info.model, provider: info.provider }) ?? fallbackProvider(info);
    return { provider, url: upstreamUrl(provider, info.path) };
  }

  function fallbackProvider(info: RequestInfo): ProviderDefinition {
    const providerId = CanonicalProvider.resolve(info.model, info.path);
    return {
      id: providerId,
      type: providerId === "anthropic" ? "anthropic" : "openai-compatible",
      paths: [info.path],
      upstreamBaseUrl: Config.cliProxyApiUrl,
      upstreamPath: info.path,
      auth: "preserve",
    };
  }

  function upstreamUrl(provider: ProviderDefinition, requestPath: string): string {
    const path = provider.upstreamPath ?? requestPath;
    return `${provider.upstreamBaseUrl.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  }

  function toWebSocketUrl(value: string): string {
    const url = new URL(value);
    if (url.protocol === "https:") url.protocol = "wss:";
    else if (url.protocol === "http:") url.protocol = "ws:";
    return url.toString();
  }

  function appendSearch(value: string, search: string): string {
    if (!search) return value;
    const url = new URL(value);
    url.search = search;
    return url.toString();
  }

  function isProviderAllowed(providerId: string, allowedProviders: readonly string[] | null): boolean {
    if (!allowedProviders || allowedProviders.length === 0) return true;
    return allowedProviders.includes(providerId);
  }
}
