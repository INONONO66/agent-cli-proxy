import { config } from "../../config";
import type { Message } from "../../types/anthropic";

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
  version: string = config.claudeCodeVersion,
): string {
  const chars = config.cchPositions
    .map((index) => messageText[index] ?? "0")
    .join("");

  return sha256hex(`${config.cchSalt}${chars}${version}`).slice(0, 3);
}

export function buildBillingHeaderValue(
  messages: Message[],
  entrypoint: string,
  version: string = config.claudeCodeVersion,
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
