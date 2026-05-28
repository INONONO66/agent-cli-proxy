import type { RequestInfo } from "../server/request-inspector";

export interface ProviderTransform {
  readonly providerId: string;
  transformHeaders?(headers: Headers, info: RequestInfo): Headers;
  transformBody?(body: unknown, info: RequestInfo): unknown;
  transformResponse?(responseBody: string, info: RequestInfo): string;
  transformStreamLine?(line: string, info: RequestInfo): string;
}

const registry = new Map<string, ProviderTransform>();

export namespace ProviderTransforms {
  export function register(transform: ProviderTransform): void {
    registry.set(transform.providerId, transform);
  }

  export function get(providerId: string): ProviderTransform | null {
    return registry.get(providerId) ?? null;
  }

  export function applyHeaders(providerId: string, headers: Headers, info: RequestInfo): Headers {
    const transform = registry.get(providerId);
    return transform?.transformHeaders ? transform.transformHeaders(headers, info) : headers;
  }

  export function applyBody(providerId: string, body: unknown, info: RequestInfo): unknown {
    const transform = registry.get(providerId);
    return transform?.transformBody ? transform.transformBody(body, info) : body;
  }

  export function applyResponse(providerId: string, responseBody: string, info: RequestInfo): string {
    const transform = registry.get(providerId);
    return transform?.transformResponse ? transform.transformResponse(responseBody, info) : responseBody;
  }

  export function applyStreamLine(providerId: string, line: string, info: RequestInfo): string {
    const transform = registry.get(providerId);
    return transform?.transformStreamLine ? transform.transformStreamLine(line, info) : line;
  }
}
