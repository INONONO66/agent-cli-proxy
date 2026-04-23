import { RequestInspector } from "./src/server/request-inspector";

const testCases = [
  {
    name: "OpenClaw jongi (Kimi)",
    headers: {
      "accept": "application/json",
      "accept-encoding": "gzip, deflate",
      "accept-language": "*",
      "anthropic-beta": "fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14",
      "anthropic-dangerous-direct-browser-access": "true",
      "anthropic-version": "2023-06-01",
      "connection": "keep-alive",
      "content-length": "126159",
      "content-type": "application/json",
      "host": "127.0.0.1:3100",
      "sec-fetch-mode": "cors",
      "user-agent": "Anthropic/JS 0.73.0",
      "x-api-key": "proxy",
      "x-stainless-arch": "x64",
      "x-stainless-helper-method": "stream",
      "x-stainless-lang": "js",
      "x-stainless-os": "Linux",
      "x-stainless-package-version": "0.73.0",
      "x-stainless-retry-count": "0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v22.22.2",
      "x-stainless-timeout": "600"
    },
    body: {
      model: "kimi-k2.6",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    }
  },
  {
    name: "OpenClaw bogi (Claude)",
    headers: {
      "user-agent": "Anthropic/JS 0.73.0",
      "x-api-key": "proxy",
      "content-type": "application/json"
    },
    body: {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true
    }
  },
  {
    name: "OpenCode",
    headers: {
      "user-agent": "opencode/1.2.3",
      "x-opencode-session": "sess-123456",
      "authorization": "Bearer sk-test123"
    },
    body: {
      model: "gpt-4",
      messages: [{ role: "user", content: "hello" }]
    }
  }
];

async function runTests() {
  for (const testCase of testCases) {
    console.log(`\n=== ${testCase.name} ===`);
    
    const req = new Request("http://localhost:3100/v1/messages", {
      method: "POST",
      headers: testCase.headers as Record<string, string>,
      body: JSON.stringify(testCase.body)
    });
    
    const info = await RequestInspector.inspect(req);
    console.log("model:", info.model);
    console.log("isClaude:", RequestInspector.isClaudeModel(info.model));
    console.log("detectedTool:", RequestInspector.detectTool(info));
    console.log("clientId:", RequestInspector.generateClientId(RequestInspector.detectTool(info), info));
    console.log("agentName:", info.agentName);
    console.log("userAgent:", info.userAgent);
    console.log("originator:", info.originator);
    console.log("sessionId:", info.sessionId);
    console.log("isStreaming:", info.isStreaming);
  }
}

runTests();
