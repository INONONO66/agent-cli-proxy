import { expect, test } from "bun:test";

const { rewriteOpenAICompatibleRequestBody } = await import("../../src/provider/openai/transform");

test("rewriteOpenAICompatibleRequestBody removes OpenAI provider namespace from model", () => {
  const rewritten = rewriteOpenAICompatibleRequestBody({
    model: "openai/gpt-5.5",
    messages: [
      { role: "user", content: "hello" },
    ],
    reasoning_effort: "medium",
  });

  expect(rewritten).toMatchObject({
    model: "gpt-5.5",
    reasoning_effort: "medium",
  });
});

test("rewriteOpenAICompatibleRequestBody preserves nonstandard reasoning effort values", () => {
  const rewritten = rewriteOpenAICompatibleRequestBody({
    model: "openai/gpt-5.5",
    messages: [
      { role: "user", content: "hello" },
    ],
    reasoning_effort: "xhigh",
  });

  expect(rewritten).toMatchObject({
    model: "gpt-5.5",
    reasoning_effort: "xhigh",
  });
});
