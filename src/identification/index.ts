export type Tool = string;

export interface ClientIdentity {
  tool: Tool;
  version?: string;
  sessionId?: string;
  projectId?: string;
  customName?: string;
}

export interface IdentificationPlugin {
  name: string;
  priority: number;
  identify(headers: Headers): ClientIdentity | null;
}

const plugins: IdentificationPlugin[] = [];

export function registerPlugin(plugin: IdentificationPlugin): void {
  plugins.push(plugin);
  plugins.sort((a, b) => b.priority - a.priority);
}

export function identifyClient(headers: Headers): ClientIdentity {
  for (const plugin of plugins) {
    const result = plugin.identify(headers);
    if (result) return result;
  }
  return { tool: "unknown" };
}

export function generateClientId(identity: ClientIdentity): string {
  if (identity.tool === "unknown") {
    return "unknown";
  }

  const parts = [identity.tool];

  if (identity.customName) {
    parts.push(identity.customName);
  } else if (identity.sessionId) {
    parts.push(identity.sessionId.slice(0, 8));
  } else if (identity.projectId) {
    parts.push(identity.projectId.slice(0, 8));
  }

  return parts.join("-");
}

function extractVersion(userAgent: string, prefix: string): string | undefined {
  const match = userAgent.match(new RegExp(`${prefix}([^\\s/]+)`));
  return match?.[1];
}

registerPlugin({
  name: "opencode",
  priority: 100,
  identify(headers) {
    const userAgent = headers.get("user-agent") || "";
    const opencodeSession = headers.get("x-opencode-session");
    const opencodeProject = headers.get("x-opencode-project");
    const initiator = headers.get("x-initiator");

    if (opencodeSession || initiator || userAgent.includes("opencode/")) {
      return {
        tool: "opencode",
        version: extractVersion(userAgent, "opencode/"),
        sessionId: opencodeSession || undefined,
        projectId: opencodeProject || undefined,
      };
    }
    return null;
  },
});

registerPlugin({
  name: "openclaw",
  priority: 100,
  identify(headers) {
    const userAgent = headers.get("user-agent") || "";
    const openclawSession = headers.get("x-openclaw-session-id");
    const openclawTurn = headers.get("x-openclaw-turn-id");
    const originator = headers.get("originator");
    const agentName = headers.get("x-agent-name");

    if (openclawSession || openclawTurn || originator === "openclaw" || agentName || userAgent.includes("openclaw-")) {
      return {
        tool: "openclaw",
        version: extractVersion(userAgent, "openclaw-"),
        sessionId: openclawSession || undefined,
        customName: agentName || undefined,
      };
    }
    return null;
  },
});

registerPlugin({
  name: "hermes-agent",
  priority: 100,
  identify(headers) {
    const userAgent = headers.get("user-agent") || "";
    const activityRequestId = headers.get("x-activity-request-id");

    if (userAgent.includes("HermesAgent") || activityRequestId) {
      return {
        tool: "hermes-agent",
        sessionId: activityRequestId || undefined,
      };
    }
    return null;
  },
});
