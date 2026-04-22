import { Config } from "../../config";
export { parseAnthropicSSELine, accumulateUsage, finalizeUsage } from "./stream-usage";

export namespace Anthropic {
  export interface SystemBlock {
    type: "text";
    text: string;
  }

  export interface ContentBlock {
    type: "text" | "tool_use" | "tool_result" | "image";
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: unknown;
  }

  export interface Message {
    role: "user" | "assistant";
    content: string | ContentBlock[];
  }

  export interface Tool {
    name: string;
    description?: string;
    input_schema?: Record<string, unknown>;
  }

  export interface Request {
    model: string;
    messages: Message[];
    system?: SystemBlock[] | string;
    tools?: Tool[];
    max_tokens?: number;
    stream?: boolean;
    [key: string]: unknown;
  }

  export interface Response {
    id: string;
    type: "message";
    role: "assistant";
    content: ContentBlock[];
    model: string;
    stop_reason: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  }

  export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    cache_creation_tokens: number;
    cache_read_tokens: number;
    total_tokens: number;
    incomplete: boolean;
  }

  export interface BillingConfig {
    version: string;
    salt: string;
    positions: number[];
  }

  export function extractFirstUserMessageText(messages: Message[]): string {
    const userMsg = messages.find((message) => message.role === "user");
    if (!userMsg) return "";

    const { content } = userMsg;
    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      const textBlock = content.find((block) => block.type === "text");
      if (textBlock?.text) return textBlock.text;
    }

    return "";
  }

  function sha256hex(text: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(text);
    return hasher.digest("hex");
  }

  export function computeCCH(messageText: string): string {
    return sha256hex(messageText).slice(0, 5);
  }

  export function computeVersionSuffix(
    messageText: string,
    version: string = Config.claudeCodeVersion,
  ): string {
    const chars = Config.cchPositions
      .map((index) => messageText[index] ?? "0")
      .join("");

    return sha256hex(`${Config.cchSalt}${chars}${version}`).slice(0, 3);
  }

  export function buildBillingHeaderValue(
    messages: Message[],
    entrypoint: string,
    version: string = Config.claudeCodeVersion,
  ): string {
    const text = extractFirstUserMessageText(messages);
    const suffix = computeVersionSuffix(text, version);
    const cch = computeCCH(text);

    return (
      "x-anthropic-billing-header: " +
      `cc_version=${version}.${suffix}; ` +
      `cc_entrypoint=${entrypoint}; ` +
      `cch=${cch};`
    );
  }

  const SESSION_ID = crypto.randomUUID();

  function detectOS(): string {
    switch (process.platform) {
      case "darwin":
        return "macOS";
      case "linux":
        return "Linux";
      case "win32":
        return "Windows";
      default:
        return "Linux";
    }
  }

  function detectArch(): string {
    return process.arch === "arm64" ? "arm64" : "x64";
  }

  export function buildClaudeCodeHeaders(): Record<string, string> {
    return {
      "user-agent": `claude-cli/${Config.claudeCodeVersion} (external, cli)`,
      "x-app": "cli",
      "x-claude-code-session-id": SESSION_ID,
      "x-stainless-arch": detectArch(),
      "x-stainless-os": detectOS(),
      "x-stainless-lang": "js",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": process.version,
      "anthropic-beta":
        "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
}
