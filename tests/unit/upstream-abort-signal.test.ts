import { afterEach, beforeEach, expect, test } from "bun:test";

process.env.CLI_PROXY_API_URL ??= "http://localhost:8317";

const { UpstreamClient } = await import("../../src/upstream/client");

const originalFetch = globalThis.fetch;

function replaceFetch(handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = Object.assign(
    ((...args: Parameters<typeof fetch>) => handler(...args)) as typeof fetch,
    { preconnect: originalFetch.preconnect },
  );
}

beforeEach(() => {
  UpstreamClient.__resetForTests();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  UpstreamClient.__resetForTests();
});

test("fallback composed abort signal removes listeners after fetch completes", async () => {
  const abortSignal = AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const userAbort = new AbortController();
  let added = 0;
  let removed = 0;

  trackAbortListeners(userAbort.signal, {
    onAdd: () => {
      added += 1;
    },
    onRemove: () => {
      removed += 1;
    },
  });
  replaceFetch(async () => new Response("ok", { status: 200 }));

  try {
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });

    const res = await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/fallback-signal",
      providerId: "fallback-signal-provider",
      signal: userAbort.signal,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  } finally {
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
    else Reflect.deleteProperty(abortSignal, "any");
  }

  expect(added).toBe(1);
  expect(removed).toBe(1);
});

test("fallback composed abort signal keeps abort propagation until response body is released", async () => {
  const abortSignal = AbortSignal as typeof AbortSignal & { any?: (signals: AbortSignal[]) => AbortSignal };
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const userAbort = new AbortController();
  let removed = 0;

  trackAbortListeners(userAbort.signal, {
    onAdd: () => {},
    onRemove: () => {
      removed += 1;
    },
  });
  replaceFetch(async (_url, init) => {
    const signal = init?.signal;
    if (!(signal instanceof AbortSignal)) throw new Error("missing composed abort signal");
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        signal.addEventListener("abort", () => {
          controller.error(new Error("mock aborted"));
        }, { once: true });
      },
    }), { status: 200 });
  });

  try {
    Object.defineProperty(AbortSignal, "any", {
      configurable: true,
      value: undefined,
    });

    const res = await UpstreamClient.fetch({
      method: "GET",
      url: "https://upstream.example/fallback-signal-stream",
      providerId: "fallback-signal-stream-provider",
      signal: userAbort.signal,
      timeoutMs: 100,
    });
    const bodyRead = res.text();

    userAbort.abort(new Error("user abort"));

    await expect(bodyRead).rejects.toThrow("mock aborted");
  } finally {
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
    else Reflect.deleteProperty(abortSignal, "any");
  }

  expect(removed).toBe(1);
});

function trackAbortListeners(
  signal: AbortSignal,
  hooks: { onAdd: () => void; onRemove: () => void },
): void {
  const addEventListener = signal.addEventListener.bind(signal) as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ) => void;
  const removeEventListener = signal.removeEventListener.bind(signal) as (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ) => void;

  const trackedAddEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void => {
    if (type === "abort") hooks.onAdd();
    addEventListener(type, listener, options);
  };
  const trackedRemoveEventListener = (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ): void => {
    if (type === "abort") hooks.onRemove();
    removeEventListener(type, listener, options);
  };
  signal.addEventListener = trackedAddEventListener as AbortSignal["addEventListener"];
  signal.removeEventListener = trackedRemoveEventListener as AbortSignal["removeEventListener"];
}
