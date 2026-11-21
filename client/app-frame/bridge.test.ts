import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppBridge, type AppBridge, type BridgeServices, type McpAppsServices } from "./bridge";
import { createConsentGate, type ConsentGate, type ConsentRequest } from "./consent";
import { buildHostContext, type AppMode } from "./host-context";

const theme = {
  colors: {
    surface0: "#101010",
    surface1: "#181818",
    surface2: "#202020",
    border: "#333333",
    foreground: "#eeeeee",
    foregroundMuted: "#999999",
    accent: "#4488ff",
    accentForeground: "#ffffff",
    statusSuccess: "#22aa55",
    statusWarning: "#ddaa22",
    statusDanger: "#dd3333",
  },
} as const;

interface Harness {
  bridge: AppBridge;
  posted: Array<Record<string, any>>;
  services: BridgeServices;
  gate: ConsentGate;
  consents: ConsentRequest[];
  clock: { now: number };
  onInitialized: ReturnType<typeof vi.fn>;
}

function makeServices(overrides: Partial<BridgeServices> = {}): BridgeServices {
  const store = new Map<string, any>();
  return {
    sendMessage: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
    requestDisplayMode: vi.fn((mode) => mode),
    setSize: vi.fn(),
    log: vi.fn(),
    storage: {
      get: vi.fn(async (key) => store.get(key) ?? null),
      set: vi.fn(async (key, value) => void store.set(key, value)),
      delete: vi.fn(async (key) => void store.delete(key)),
      keys: vi.fn(async () => [...store.keys()]),
    },
    load: vi.fn(async (path) => ({ loaded: path })),
    download: vi.fn(async () => undefined),
    ai: vi.fn(async () => "answer"),
    ...overrides,
  };
}

function harness(mode: AppMode = "genui", services = makeServices(), always: string[] = []): Harness {
  const posted: Array<Record<string, any>> = [];
  const clock = { now: 1_000_000 };
  const consents: ConsentRequest[] = [];
  const gate = createConsentGate({ isAlways: (kind) => always.includes(kind), persistAlways: () => undefined });
  const onInitialized = vi.fn();
  const bridge = createAppBridge({
    mode,
    version: "9.9.9",
    getHostContext: () =>
      buildHostContext({ theme, mode, displayMode: "inline", platform: "web", maxInlineHeight: 1400, version: "9.9.9", toolName: mode === "mcp" ? "t" : undefined }),
    approvedDomains: () => ({ connectDomains: ["https://api.example.com"], resourceDomains: [] }),
    post: (message) => posted.push(message),
    services,
    consent: (request) => {
      consents.push(request);
      return gate.request(request);
    },
    onInitialized,
    now: () => clock.now,
  });
  return { bridge, posted, services, gate, consents, clock, onInitialized };
}

const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: "2.0", id, method, params });

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: false }));
afterEach(() => vi.useRealTimers());

// Fake timers: flush microtasks with an explicit helper instead of real timeouts.
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

async function run(h: Harness, id: number, method: string, params?: unknown): Promise<Record<string, any>> {
  h.bridge.handle(request(id, method, params));
  await settle();
  const reply = h.posted.find((message) => message.id === id);
  if (reply === undefined) throw new Error(`no reply to ${id}`);
  return reply;
}

async function initialize(h: Harness): Promise<Record<string, any>> {
  h.bridge.handle(request(0, "ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "app", version: "1" }, appCapabilities: { availableDisplayModes: ["inline"] } }));
  await settle();
  const result = h.posted.find((message) => message.id === 0)!;
  h.bridge.handle({ jsonrpc: "2.0", method: "ui/notifications/initialized", params: {} });
  await settle();
  return result;
}

describe("ui/initialize", () => {
  it("returns the MCP Apps result shape", async () => {
    const h = harness();
    const reply = await run(h, 1, "ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "app", version: "1" }, appCapabilities: {} });
    expect(reply.jsonrpc).toBe("2.0");
    expect(reply.result.protocolVersion).toBe("2026-01-26");
    expect(reply.result.hostInfo).toEqual({ name: "Paseo", version: "9.9.9" });
    expect(reply.result.hostCapabilities.openLinks).toEqual({});
    expect(reply.result.hostCapabilities.serverTools).toBeUndefined();
    expect(reply.result.hostCapabilities.sandbox.csp.connectDomains).toEqual(["https://api.example.com"]);
    const ctx = reply.result.hostContext;
    expect(ctx.theme).toBe("dark");
    expect(ctx.displayMode).toBe("inline");
    expect(ctx.availableDisplayModes).toEqual(["inline", "fullscreen"]);
    expect(ctx.platform).toBe("web");
    expect(ctx.containerDimensions).toEqual({ maxHeight: 1400 });
    expect(typeof ctx.locale).toBe("string");
    expect(typeof ctx.timeZone).toBe("string");
    expect(ctx.styles.variables["--color-background-primary"]).toBe("#101010");
    // genui pages also get Paseo's own variables.
    expect(ctx.styles.variables["--background"]).toBe("#101010");
  });

  it("accepts the clientInfo spelling of the 2026-01-26 doc and rejects malformed params", async () => {
    const h = harness();
    expect((await run(h, 1, "ui/initialize", { protocolVersion: "2026-01-26", clientInfo: { name: "x", version: "1" } })).result).toBeDefined();
    const bad = await run(h, 2, "ui/initialize", { protocolVersion: 12 });
    expect(bad.error.code).toBe(-32602);
  });

  it("refuses every other request before ui/initialize", async () => {
    const h = harness();
    const reply = await run(h, 1, "paseo/storage/keys", {});
    expect(reply.error.code).toBe(-32002);
    expect(h.services.storage!.keys).not.toHaveBeenCalled();
    expect((await run(h, 2, "ping")).result).toEqual({});
  });

  it("holds host notifications until the page says initialized", async () => {
    const h = harness("mcp", makeServices({ mcp: { callTool: vi.fn(), readResource: vi.fn() } as McpAppsServices }));
    h.bridge.handle(request(1, "ui/initialize", { protocolVersion: "2026-01-26" }));
    await settle();
    h.bridge.sendToolInput({ q: 1 });
    h.bridge.sendToolResult({ content: [{ type: "text", text: "hi" }] });
    h.bridge.notifyHostContext({ theme: "light" });
    expect(h.posted.map((m) => m.method).filter(Boolean)).toEqual([]);
    h.bridge.handle({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    await settle();
    expect(h.posted.map((m) => m.method).filter(Boolean)).toEqual([
      "ui/notifications/tool-input",
      "ui/notifications/tool-result",
      "ui/notifications/host-context-changed",
    ]);
    expect(h.onInitialized).toHaveBeenCalledTimes(1);
    expect(h.posted.find((m) => m.method === "ui/notifications/tool-input")!.params).toEqual({ arguments: { q: 1 } });
  });

  it("mcp hosts advertise serverTools and serverResources only with an mcp service", async () => {
    const h = harness("mcp", makeServices({ mcp: { callTool: vi.fn(), readResource: vi.fn() } as McpAppsServices }));
    const reply = await run(h, 1, "ui/initialize", { protocolVersion: "2026-01-26" });
    expect(reply.result.hostCapabilities.serverTools).toEqual({});
    expect(reply.result.hostCapabilities.serverResources).toEqual({});
    expect(reply.result.hostContext.toolInfo.tool.name).toBe("t");
    expect(reply.result.hostContext.styles.variables["--background"]).toBeUndefined();
  });
});

describe("framing and unknown methods", () => {
  it("ignores non-JSON-RPC traffic and answers malformed requests", async () => {
    const h = harness();
    await initialize(h);
    const before = h.posted.length;
    for (const junk of ["text", 5, null, [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { type: "height", height: 5 }]) h.bridge.handle(junk);
    await settle();
    expect(h.posted.length).toBe(before);
    h.bridge.handle({ jsonrpc: "2.0", id: 7, method: 5 });
    await settle();
    expect(h.posted.find((m) => m.id === 7)!.error.code).toBe(-32600);
  });

  it("answers anything else with -32601, including prototype keys", async () => {
    const h = harness();
    await initialize(h);
    for (const [index, method] of ["nope", "ui/update-model-context", "ui/download-file", "sampling/createMessage", "__proto__", "constructor", "toString", "paseo/storage"].entries()) {
      const reply = await run(h, 100 + index, method, {});
      expect(reply.error.code, method).toBe(-32601);
    }
  });

  it("answers mode-specific methods with -32601 in the other mode", async () => {
    const genui = harness("genui");
    await initialize(genui);
    expect((await run(genui, 1, "tools/call", { name: "x" })).error.code).toBe(-32601);
    expect((await run(genui, 2, "resources/read", { uri: "ui://x" })).error.code).toBe(-32601);

    const mcp = harness("mcp", makeServices({ mcp: { callTool: vi.fn(), readResource: vi.fn() } as McpAppsServices }));
    await initialize(mcp);
    for (const [index, method] of ["paseo/storage/get", "paseo/storage/set", "paseo/load", "paseo/download", "paseo/ai"].entries()) {
      expect((await run(mcp, index + 1, method, {})).error.code, method).toBe(-32601);
    }
  });

  it("does not answer notifications", async () => {
    const h = harness();
    await initialize(h);
    const before = h.posted.length;
    h.bridge.handle({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "x" } });
    h.bridge.handle({ jsonrpc: "2.0", method: "bogus" });
    await settle();
    expect(h.posted.length).toBe(before);
  });
});

describe("ui/message", () => {
  it("asks first, then posts the text", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "ui/message", { role: "user", content: { type: "text", text: "hello there" } }));
    await settle();
    expect(h.services.sendMessage).not.toHaveBeenCalled();
    expect(h.gate.pending).toHaveLength(1);
    expect(h.gate.pending[0]!.request).toMatchObject({ kind: "message", detail: "hello there" });
    h.gate.decide(h.gate.pending[0]!.id, "allow");
    await settle();
    expect(h.services.sendMessage).toHaveBeenCalledWith("hello there");
    expect(h.posted.find((m) => m.id === 1)!.result).toEqual({});
  });

  it("accepts the SDK's content-block array", async () => {
    const h = harness("genui", makeServices(), ["message"]);
    await initialize(h);
    const reply = await run(h, 1, "ui/message", { role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] });
    expect(reply.result).toEqual({});
    expect(h.services.sendMessage).toHaveBeenCalledWith("a\n\nb");
  });

  it("refuses when the user cancels, with a JSON-RPC error, and never sends", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "ui/message", { role: "user", content: { type: "text", text: "x" } }));
    await settle();
    h.gate.decide(h.gate.pending[0]!.id, "cancel");
    await settle();
    expect(h.posted.find((m) => m.id === 1)!.error).toMatchObject({ code: -32000, message: "denied by the user" });
    expect(h.services.sendMessage).not.toHaveBeenCalled();
  });

  it("times out after two minutes", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "ui/message", { role: "user", content: { type: "text", text: "x" } }));
    await vi.advanceTimersByTimeAsync(120_001);
    expect(h.posted.find((m) => m.id === 1)!.error.message).toMatch(/did not answer/);
    expect(h.gate.pending).toHaveLength(0);
    expect(h.services.sendMessage).not.toHaveBeenCalled();
  });

  it("rejects bad params: wrong role, empty, oversize, non-text, missing content", async () => {
    const h = harness("genui", makeServices(), ["message"]);
    await initialize(h);
    const cases: unknown[] = [
      { role: "assistant", content: { type: "text", text: "x" } },
      { role: "user", content: { type: "text", text: "   " } },
      { role: "user", content: { type: "text", text: "a".repeat(8001) } },
      { role: "user", content: { type: "image", data: "x", mimeType: "image/png" } },
      { role: "user" },
      "string",
      undefined,
    ];
    for (const [index, params] of cases.entries()) {
      h.clock.now += 5000;
      const reply = await run(h, 10 + index, "ui/message", params);
      expect(reply.error.code, JSON.stringify(params)).toBe(-32602);
    }
    expect(h.services.sendMessage).not.toHaveBeenCalled();
    h.clock.now += 5000;
    expect((await run(h, 50, "ui/message", { role: "user", content: { type: "text", text: "a".repeat(8000) } })).result).toEqual({});
  });

  it("limits messages to one per 3 seconds", async () => {
    const h = harness("genui", makeServices(), ["message"]);
    await initialize(h);
    const text = { role: "user", content: { type: "text", text: "hi" } };
    expect((await run(h, 1, "ui/message", text)).result).toEqual({});
    expect((await run(h, 2, "ui/message", text)).error.message).toMatch(/rate limited/);
    h.clock.now += 3001;
    expect((await run(h, 3, "ui/message", text)).result).toEqual({});
    expect(h.services.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("refuses when too many requests are waiting for the user", async () => {
    const h = harness("genui", makeServices(), []);
    await initialize(h);
    for (let id = 1; id <= 5; id++) {
      h.clock.now += 3001;
      h.bridge.handle(request(id, "ui/message", { role: "user", content: { type: "text", text: `m${id}` } }));
      await settle();
    }
    expect(h.gate.pending).toHaveLength(3);
    expect(h.posted.filter((m) => m.error?.message === "too many requests are waiting for the user")).toHaveLength(2);
  });
});

describe("ui/open-link", () => {
  it("shows the full url, then opens it", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "ui/open-link", { url: "https://Example.com/path?q=1" }));
    await settle();
    expect(h.gate.pending[0]!.request).toMatchObject({ kind: "link", detail: "https://example.com/path?q=1" });
    h.gate.decide(h.gate.pending[0]!.id, "allow");
    await settle();
    expect(h.services.openLink).toHaveBeenCalledWith("https://example.com/path?q=1");
    expect(h.posted.find((m) => m.id === 1)!.result).toEqual({});
  });

  it("refuses non-https, credentialed and malformed links without asking", async () => {
    const h = harness();
    await initialize(h);
    for (const [index, url] of ["http://example.com", "javascript:alert(1)", "https://u:p@example.com", "ftp://x.com", "not a url", ""].entries()) {
      const reply = await run(h, index + 1, "ui/open-link", { url });
      expect(reply.error.message, url).toMatch(/https/);
    }
    expect((await run(h, 20, "ui/open-link", {})).error.code).toBe(-32602);
    expect((await run(h, 21, "ui/open-link", { url: "https://x.com/" + "a".repeat(2100) })).error.code).toBe(-32602);
    expect(h.gate.pending).toHaveLength(0);
    expect(h.services.openLink).not.toHaveBeenCalled();
  });

  it("does not ask again once the user chose Always", async () => {
    const h = harness("genui", makeServices(), ["link"]);
    await initialize(h);
    expect((await run(h, 1, "ui/open-link", { url: "https://example.com/" })).result).toEqual({});
    expect(h.consents).toHaveLength(1);
    expect(h.gate.pending).toHaveLength(0);
  });
});

describe("ui/request-display-mode and size", () => {
  it("returns the mode actually set and keeps pip at the current mode", async () => {
    const h = harness();
    await initialize(h);
    expect((await run(h, 1, "ui/request-display-mode", { mode: "fullscreen" })).result).toEqual({ mode: "fullscreen" });
    expect(h.services.requestDisplayMode).toHaveBeenCalledWith("fullscreen");
    expect((await run(h, 2, "ui/request-display-mode", { mode: "pip" })).result).toEqual({ mode: "inline" });
    expect((await run(h, 3, "ui/request-display-mode", { mode: "sideways" })).error.code).toBe(-32602);
  });

  it("clamps size-changed to 80-1400 and ignores junk", async () => {
    const h = harness();
    await initialize(h);
    for (const height of [10, 300.2, 99_999]) h.bridge.handle({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height } });
    h.bridge.handle({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: "tall" } });
    h.bridge.handle({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: -5 } });
    await settle();
    expect((h.services.setSize as any).mock.calls).toEqual([[80], [301], [1400]]);
  });
});

describe("notifications/message", () => {
  it("logs with a cap and never shows UI", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle({ jsonrpc: "2.0", method: "notifications/message", params: { level: "warning", logger: "app", data: { a: 1 } } });
    h.bridge.handle({ jsonrpc: "2.0", method: "notifications/message", params: { data: "x".repeat(5000) } });
    await settle();
    const calls = (h.services.log as any).mock.calls;
    expect(calls[0]).toEqual(["warning", 'app: {"a":1}']);
    expect(calls[1][1].length).toBeLessThanOrEqual(2001);
    expect(h.gate.pending).toHaveLength(0);
  });
});

describe("paseo/storage", () => {
  it("round-trips values through the service", async () => {
    const h = harness();
    await initialize(h);
    expect((await run(h, 1, "paseo/storage/set", { key: "k", value: { n: [1, 2] } })).result).toEqual({});
    expect((await run(h, 2, "paseo/storage/get", { key: "k" })).result).toEqual({ value: { n: [1, 2] } });
    expect((await run(h, 3, "paseo/storage/get", { key: "missing" })).result).toEqual({ value: null });
    expect((await run(h, 4, "paseo/storage/keys")).result).toEqual({ keys: ["k"] });
    expect((await run(h, 5, "paseo/storage/delete", { key: "k" })).result).toEqual({});
    expect((await run(h, 6, "paseo/storage/keys", {})).result).toEqual({ keys: [] });
  });

  it("rejects bad keys and values", async () => {
    const h = harness();
    await initialize(h);
    const cases: Array<[string, unknown]> = [
      ["paseo/storage/get", {}],
      ["paseo/storage/get", { key: "" }],
      ["paseo/storage/get", { key: "k".repeat(201) }],
      ["paseo/storage/get", { key: 5 }],
      ["paseo/storage/set", { key: "k" }],
      ["paseo/storage/set", { value: 1 }],
      ["paseo/storage/set", { key: "k".repeat(201), value: 1 }],
      ["paseo/storage/delete", { key: {} }],
    ];
    for (const [index, [method, params]] of cases.entries()) {
      expect((await run(h, index + 1, method, params)).error.code, `${method} ${JSON.stringify(params)}`).toBe(-32602);
    }
    expect(h.services.storage!.set).not.toHaveBeenCalled();
    expect((await run(h, 50, "paseo/storage/get", { key: "k".repeat(200) })).result).toEqual({ value: null });
  });

  it("passes the daemon's full-storage error to the page", async () => {
    const h = harness("genui", makeServices({ storage: { get: vi.fn(), set: vi.fn(async () => { throw new Error("app storage is full (1 MB per app)"); }), delete: vi.fn(), keys: vi.fn() } }));
    await initialize(h);
    const reply = await run(h, 1, "paseo/storage/set", { key: "k", value: "x" });
    expect(reply.error).toMatchObject({ code: -32000, message: "app storage is full (1 MB per app)" });
  });
});

describe("paseo/load", () => {
  it("loads through the service and wraps the value", async () => {
    const h = harness();
    await initialize(h);
    expect((await run(h, 1, "paseo/load", { path: "$BB_THREAD_STORAGE/data.json" })).result).toEqual({ value: { loaded: "$BB_THREAD_STORAGE/data.json" } });
  });

  it("rejects empty, huge and control-character paths and reports service refusals", async () => {
    const h = harness("genui", makeServices({ load: vi.fn(async () => { throw new Error("only files in this agent's workspace…"); }) }));
    await initialize(h);
    for (const [index, path] of ["", "a".repeat(1025), "a\u0000b", "a\nb", 5, undefined].entries()) {
      expect((await run(h, index + 1, "paseo/load", { path })).error.code, String(path)).toBe(-32602);
    }
    expect((await run(h, 20, "paseo/load", { path: "/etc/passwd" })).error.message).toMatch(/only files/);
  });

  it("refuses results over 4 MB", async () => {
    const h = harness("genui", makeServices({ load: vi.fn(async () => "x".repeat(4 * 1024 * 1024 + 10)) }));
    await initialize(h);
    expect((await run(h, 1, "paseo/load", { path: "big.txt" })).error.message).toBe("result is over 4 MB");
  });
});

describe("paseo/download", () => {
  const text = { filename: "notes.txt", mimeType: "text/plain", text: "hello" };

  it("hands text and base64 files to the service", async () => {
    const h = harness();
    await initialize(h);
    expect((await run(h, 1, "paseo/download", text)).result).toEqual({});
    expect((await run(h, 2, "paseo/download", { filename: "a.bin", mimeType: "application/octet-stream", base64: "aGVsbG8=" })).result).toEqual({});
    expect(h.services.download).toHaveBeenCalledTimes(2);
  });

  it("rejects: both or neither body, bad mime, bad base64, oversize, empty filename", async () => {
    const h = harness();
    await initialize(h);
    const cases: unknown[] = [
      { ...text, base64: "aGVsbG8=" },
      { filename: "a", mimeType: "text/plain" },
      { ...text, mimeType: "text/html; x=1" },
      { filename: "a", mimeType: "text/plain", base64: "not base64!" },
      { filename: "a", mimeType: "text/plain", text: "x".repeat(10 * 1024 * 1024 + 1) },
      { filename: "a", mimeType: "text/plain", base64: "A".repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 8) },
      { ...text, filename: "" },
    ];
    for (const [index, params] of cases.entries()) {
      expect((await run(h, index + 1, "paseo/download", params)).error.code, String(index)).toBe(-32602);
    }
    expect(h.services.download).not.toHaveBeenCalled();
  });

  it("limits downloads to 10 a minute", async () => {
    const h = harness();
    await initialize(h);
    for (let id = 1; id <= 10; id++) expect((await run(h, id, "paseo/download", text)).result).toEqual({});
    expect((await run(h, 11, "paseo/download", text)).error.message).toMatch(/rate limited/);
    h.clock.now += 61_000;
    expect((await run(h, 12, "paseo/download", text)).result).toEqual({});
  });
});

describe("paseo/ai", () => {
  it("asks once, then answers; Allow holds for the rest of the session", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "paseo/ai", { prompt: "summarize" }));
    await settle();
    expect(h.gate.pending[0]!.request).toMatchObject({ kind: "ai", detail: "summarize" });
    h.gate.decide(h.gate.pending[0]!.id, "allow");
    await settle();
    expect(h.posted.find((m) => m.id === 1)!.result).toEqual({ text: "answer" });
    expect((await run(h, 2, "paseo/ai", { prompt: "again", system: "be brief", maxTokens: 50 })).result).toEqual({ text: "answer" });
    expect(h.services.ai).toHaveBeenLastCalledWith({ prompt: "again", system: "be brief", maxTokens: 50 });
    expect(h.consents).toHaveLength(2);
    expect(h.gate.pending).toHaveLength(0);
  });

  it("never calls the service without consent", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.handle(request(1, "paseo/ai", { prompt: "x" }));
    await settle();
    h.gate.decide(h.gate.pending[0]!.id, "cancel");
    await settle();
    expect(h.posted.find((m) => m.id === 1)!.error.message).toBe("denied by the user");
    expect(h.services.ai).not.toHaveBeenCalled();
  });

  it("rejects bad params and reports AI turned off", async () => {
    const h = harness("genui", makeServices(), ["ai"]);
    await initialize(h);
    for (const [index, params] of [{}, { prompt: "" }, { prompt: "x".repeat(16_001) }, { prompt: "x", maxTokens: 2001 }, { prompt: "x", maxTokens: 0 }, { prompt: "x", maxTokens: 1.5 }, { prompt: "x", system: "y".repeat(4001) }].entries()) {
      expect((await run(h, index + 1, "paseo/ai", params)).error.code, JSON.stringify(params).slice(0, 40)).toBe(-32602);
    }
    expect(h.services.ai).not.toHaveBeenCalled();

    const off = harness("genui", makeServices({ ai: undefined }), ["ai"]);
    await initialize(off);
    expect((await run(off, 1, "paseo/ai", { prompt: "x" })).error.message).toMatch(/turned off/);
    expect(off.gate.pending).toHaveLength(0);
  });
});

describe("mcp mode", () => {
  const mcpServices = () => ({
    callTool: vi.fn(async (req: { name: string; arguments: Record<string, unknown> }) => ({ content: [{ type: "text", text: `called ${req.name}` }], structuredContent: req.arguments })),
    readResource: vi.fn(async (req: { uri: string }) => ({ contents: [{ uri: req.uri, text: "x" }] })),
  });

  it("proxies tools/call and resources/read", async () => {
    const mcp = mcpServices();
    const h = harness("mcp", makeServices({ mcp }));
    await initialize(h);
    expect((await run(h, 1, "tools/call", { name: "refresh", arguments: { a: 1 } })).result).toEqual({ content: [{ type: "text", text: "called refresh" }], structuredContent: { a: 1 } });
    expect(mcp.callTool).toHaveBeenCalledWith({ name: "refresh", arguments: { a: 1 } });
    expect((await run(h, 2, "tools/call", { name: "noargs" })).result).toBeDefined();
    expect(mcp.callTool).toHaveBeenLastCalledWith({ name: "noargs", arguments: {} });
    expect((await run(h, 3, "resources/read", { uri: "ui://x/y" })).result).toEqual({ contents: [{ uri: "ui://x/y", text: "x" }] });
  });

  it("rejects bad params and passes the server's refusal through", async () => {
    const mcp = mcpServices();
    mcp.callTool.mockRejectedValueOnce(new Error("tool is not visible to apps"));
    const h = harness("mcp", makeServices({ mcp }));
    await initialize(h);
    expect((await run(h, 1, "tools/call", { name: "hidden" })).error.message).toBe("tool is not visible to apps");
    for (const [index, [method, params]] of ([["tools/call", {}], ["tools/call", { name: "" }], ["tools/call", { name: "x", arguments: [1] }], ["tools/call", { name: "x".repeat(201) }], ["resources/read", {}], ["resources/read", { uri: "" }]] as Array<[string, unknown]>).entries()) {
      expect((await run(h, 10 + index, method, params)).error.code, method).toBe(-32602);
    }
  });

  it("reports -32601 when no mcp service was given", async () => {
    const h = harness("mcp", makeServices());
    await initialize(h);
    expect((await run(h, 1, "tools/call", { name: "x" })).error.code).toBe(-32601);
  });

  it("sends tool-cancelled and ignores tool notifications in genui mode", async () => {
    const mcp = harness("mcp", makeServices({ mcp: mcpServices() }));
    await initialize(mcp);
    mcp.bridge.sendToolCancelled("stopped");
    expect(mcp.posted.at(-1)).toEqual({ jsonrpc: "2.0", method: "ui/notifications/tool-cancelled", params: { reason: "stopped" } });
    const genui = harness("genui");
    await initialize(genui);
    const before = genui.posted.length;
    genui.bridge.sendToolInput({ a: 1 });
    genui.bridge.sendToolResult({});
    expect(genui.posted.length).toBe(before);
  });
});

describe("rate limits and lifecycle", () => {
  it("answers requests beyond 50 per 10 seconds with an error, then recovers", async () => {
    const h = harness();
    await initialize(h);
    // initialize used 2 of the 50.
    for (let id = 1; id <= 48; id++) h.bridge.handle(request(id, "ping"));
    await settle();
    expect(h.posted.filter((m) => m.id !== undefined && m.result !== undefined && m.id !== 0)).toHaveLength(48);
    h.bridge.handle(request(100, "ping"));
    await settle();
    expect(h.posted.find((m) => m.id === 100)!.error.message).toMatch(/rate limited/);
    h.clock.now += 10_001;
    expect((await run(h, 101, "ping")).result).toEqual({});
  });

  it("stops talking after dispose", async () => {
    const h = harness();
    await initialize(h);
    h.bridge.dispose();
    const before = h.posted.length;
    h.bridge.handle(request(1, "ping"));
    h.bridge.notifyHostContext({ theme: "light" });
    await settle();
    expect(h.posted.length).toBe(before);
  });

  it("teardown asks the page and waits for the answer or the timeout", async () => {
    const h = harness();
    await initialize(h);
    const done = h.bridge.teardown("fullscreen");
    const sent = h.posted.at(-1)!;
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "ui/resource-teardown", params: { reason: "fullscreen" } });
    h.bridge.handle({ jsonrpc: "2.0", id: sent.id, result: {} });
    await done;

    const slow = h.bridge.teardown("unmount", 400);
    await vi.advanceTimersByTimeAsync(401);
    await slow;
  });

  it("teardown does nothing before the page initialized", async () => {
    const h = harness();
    const before = h.posted.length;
    await h.bridge.teardown("x");
    expect(h.posted.length).toBe(before);
  });
});
