import { Config } from "../../config";
import { Anthropic } from "./index";

const OPENCODE_IDENTITY_PREFIX = "You are OpenCode";
const CLAUDE_CODE_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";
const CLAUDE_CODE_ENTRYPOINT = "sdk-cli";

const PARAGRAPH_REMOVAL_ANCHORS = [
  "github.com/anomalyco/opencode",
  "opencode.ai/docs",
];

const TEXT_REPLACEMENTS: { match: string; replacement: string }[] = [
  { match: "if OpenCode honestly", replacement: "if the assistant honestly" },
];

function prefixName(name: string): string {
  return `${Config.toolPrefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

function unprefixName(name: string): string {
  if (name === "StructuredOutput") return name;
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

function sanitizeText(text: string): string {
  const paragraphs = text.split(/\n\n+/);

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) return false;

    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false;
    }

    return true;
  });

  let result = filtered.join("\n\n");

  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement);
  }

  return result.trim();
}

export function sanitizeSystemText(system: Anthropic.SystemBlock[]): Anthropic.SystemBlock[] {
  return system
    .map((block) => ({ ...block, text: sanitizeText(block.text) }))
    .filter((block) => block.text.length > 0);
}

export function prependClaudeCodeIdentity(
  system: Anthropic.SystemBlock[],
  billingHeader: string,
): Anthropic.SystemBlock[] {
  const identityBlock: Anthropic.SystemBlock = { type: "text", text: CLAUDE_CODE_IDENTITY };

  if (system.length > 0 && system[0]?.text === CLAUDE_CODE_IDENTITY) {
    return system;
  }

  const result = [identityBlock, ...system];

  if (billingHeader) {
    result.unshift({ type: "text", text: billingHeader });
  }

  return result;
}

export function prefixToolNames(body: Anthropic.Request): Anthropic.Request {
  const result = { ...body };

  if (result.tools && Array.isArray(result.tools)) {
    result.tools = result.tools.map((tool) => ({
      ...tool,
      name: tool.name ? prefixName(tool.name) : tool.name,
    }));
  }

  if (result.messages && Array.isArray(result.messages)) {
    result.messages = result.messages.map((msg) => {
      if (msg.content && Array.isArray(msg.content)) {
        return {
          ...msg,
          content: msg.content.map((block) => {
            if (block.type === "tool_use" && block.name) {
              return { ...block, name: prefixName(block.name) };
            }
            return block;
          }),
        };
      }
      return msg;
    });
  }

  return result;
}

export function stripToolPrefix(body: Anthropic.Response): Anthropic.Response {
  return {
    ...body,
    content: body.content.map((block) => {
      if (block.type === "tool_use" && block.name?.startsWith(Config.toolPrefix)) {
        return {
          ...block,
          name: unprefixName(block.name.slice(Config.toolPrefix.length)),
        };
      }
      return block;
    }),
  };
}

export function stripToolPrefixFromLine(line: string): string {
  return line.replace(
    /"name"\s*:\s*"mcp_([^"]+)"/g,
    (_match, name: string) => `"name": "${unprefixName(name)}"`,
  );
}

function normalizeSystem(system: Anthropic.Request["system"]): Anthropic.SystemBlock[] {
  if (system == null) return [];
  if (typeof system === "string") {
    return system.length > 0 ? [{ type: "text", text: system }] : [];
  }
  return system;
}

function hasUserMessage(messages: Anthropic.Message[]): boolean {
  return messages.some((m) => m.role === "user");
}

export function rewriteRequestBody(body: Anthropic.Request): Anthropic.Request {
  const result = { ...body };

  const rawSystem = normalizeSystem(result.system);
  const sanitized = sanitizeSystemText(rawSystem);

  const billingHeader =
    result.messages && hasUserMessage(result.messages)
      ? Anthropic.buildBillingHeaderValue(result.messages, CLAUDE_CODE_ENTRYPOINT)
      : "";

  const withIdentity = prependClaudeCodeIdentity(sanitized, billingHeader);

  const coreBlockCount = billingHeader ? 2 : 1;

  if (withIdentity.length > coreBlockCount && result.messages && Array.isArray(result.messages)) {
    const kept = withIdentity.slice(0, coreBlockCount);
    const movedTexts: string[] = [];

    for (let i = coreBlockCount; i < withIdentity.length; i++) {
      const entry = withIdentity[i]!;
      if (entry.text.length > 0) movedTexts.push(entry.text);
    }

    if (movedTexts.length > 0) {
      const firstUser = result.messages.find((m) => m.role === "user");

      if (firstUser) {
        result.system = kept;
        const prefix = movedTexts.join("\n\n");

        result.messages = result.messages.map((msg) => {
          if (msg !== firstUser) return msg;

          if (typeof msg.content === "string") {
            return { ...msg, content: `${prefix}\n\n${msg.content}` };
          } else if (Array.isArray(msg.content)) {
            return {
              ...msg,
              content: [
                { type: "text" as const, text: prefix } as Anthropic.ContentBlock,
                ...msg.content,
              ],
            };
          }
          return msg;
        });
      } else {
        result.system = withIdentity;
      }
    } else {
      result.system = kept;
    }
  } else {
    result.system = withIdentity;
  }

  return prefixToolNames(result);
}
