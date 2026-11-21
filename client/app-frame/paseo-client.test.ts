import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { createAppBridge, type AppBridge, type BridgeServices } from "./bridge";
import { createConsentGate, type ConsentGate } from "./consent";
import { buildHostContext } from "./host-context";
import { PASEO_CLIENT_SOURCE } from "./paseo-client";
import { buildPageHtml } from "./page";

const theme = {
  colors: {
    surface0: "#fafafa",
    surface1: "#ffffff",
    surface2: "#eeeeee",
    border: "#dddddd",
    foreground: "#111111",
    foregroundMuted: "#666666",
    accent: "#0055ff",
    accentForeground: "#ffffff",
    statusSuccess: "#00aa44",
    statusWarning: "#cc9900",
    statusDanger: "#cc2222",
  },
} as const;

interface Page {
  window: any;
  paseo: any;
  deliver(message: unknown, source?: unknown): void;
  sent: any[];
  style: Record<string, string>;
}

/** Runs the injected client in a vm with a fake window whose parent is the real AppBridge. */
function openPage(options: { services?: Partial<BridgeServices>; always?: Array<"message" | "link" | "ai"> } = {}) {
  const listeners: Array<(event: { source: unknown; data: unknown }) => void> = [];
  const sent: any[] = [];
  const style: Record<string, string> = {};
  const gate = createConsentGate({ isAlways: (kind) => (options.always ?? []).includes(kind), persistAlways: () => undefined });
  const store = new Map<string, unknown>();
  const services: BridgeServices = {
    sendMessage: vi.fn(async () => undefined),
    openLink: vi.fn(async () => undefined),
    requestDisplayMode: (mode) => mode,
    setSize: vi.fn(),
    log: vi.fn(),
    storage: {
      get: async (key) => (store.get(key) as any) ?? null,
      set: async (key, value) => void store.set(key, value),
      delete: async (key) => void store.delete(key),
      keys: async () => [...store.keys()],
    },
    load: async (path) => ({ path }),
    download: vi.fn(async () => undefined),
    ai: async () => "42",
    ...options.services,
  };
  const parent = {
    postMessage(message: unknown) {
      sent.push(message);
      bridge.handle(message);
    },
  };
  const window: any = {
    parent,
    addEventListener(type: string, listener: (event: { source: unknown; data: unknown }) => void) {
      if (type === "message") listeners.push(listener);
    },
  };
  const bridge = createAppBridge({
    mode: "genui",
    version: "test",
    getHostContext: () => buildHostContext({ theme, mode: "genui", displayMode: "inline", platform: "web", maxInlineHeight: 1400, version: "test" }),
    approvedDomains: () => ({ connectDomains: [], resourceDomains: [] }),
    post: (message) => deliver(message),
    services,
    consent: (request) => gate.request(request),
    now: Date.now,
  });
  function deliver(message: unknown, source: unknown = parent) {
    // The real frame delivers asynchronously.
    queueMicrotask(() => listeners.forEach((listener) => listener({ source, data: message })));
  }
  const context = vm.createContext({
    window,
    document: { documentElement: { style: { setProperty: (name: string, value: string) => (style[name] = value) }, dataset: {} } },
    Object,
    Promise,
    Error,
    console,
  });
  vm.runInContext(PASEO_CLIENT_SOURCE, context);
  return { window, paseo: window.paseo, deliver, sent, style, gate, services, bridge } as Page & { gate: ConsentGate; services: BridgeServices; bridge: AppBridge };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("window.paseo (injected client)", () => {
  it("performs ui/initialize, then announces initialized", async () => {
    const page = openPage();
    const context = await page.paseo.ready;
    expect(context.theme).toBe("light");
    expect(page.paseo.context).toBe(context);
    expect(page.sent[0]).toMatchObject({ jsonrpc: "2.0", method: "ui/initialize", params: { protocolVersion: "2026-01-26", appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] } } });
    expect(page.sent[1]).toMatchObject({ jsonrpc: "2.0", method: "ui/notifications/initialized" });
    expect(page.sent[1].id).toBeUndefined();
    expect(page.style["--background"]).toBe("#fafafa");
    expect(page.style["--color-text-primary"]).toBe("#111111");
  });

  it("does not replace an existing window.paseo", () => {
    const sandbox: any = { window: { paseo: "mine", parent: {}, addEventListener() {} }, Object, Promise, Error };
    vm.runInContext(PASEO_CLIENT_SOURCE, vm.createContext(sandbox));
    expect(sandbox.window.paseo).toBe("mine");
  });

  it("storage round trip, load and ai", async () => {
    const page = openPage();
    await page.paseo.ready;
    expect(await page.paseo.storage.get("k")).toBeNull();
    await page.paseo.storage.set("k", { a: [1, 2, 3] });
    expect(await page.paseo.storage.get("k")).toEqual({ a: [1, 2, 3] });
    await page.paseo.storage.set("j", 1);
    expect((await page.paseo.storage.keys()).sort()).toEqual(["j", "k"]);
    await page.paseo.storage.delete("k");
    expect(await page.paseo.storage.keys()).toEqual(["j"]);
    expect(await page.paseo.load("$BB_THREAD_STORAGE/data.json")).toEqual({ path: "$BB_THREAD_STORAGE/data.json" });
  });

  it("sendMessage, openLink and ai wait for consent and resolve after Allow", async () => {
    const page = openPage();
    await page.paseo.ready;
    const sent = page.paseo.sendMessage("hello");
    await tick();
    expect(page.gate.pending).toHaveLength(1);
    expect(page.services.sendMessage).not.toHaveBeenCalled();
    page.gate.decide(page.gate.pending[0]!.id, "allow");
    await expect(sent).resolves.toBeUndefined();
    expect(page.services.sendMessage).toHaveBeenCalledWith("hello");

    const link = page.paseo.openLink("https://example.com/x");
    await tick();
    page.gate.decide(page.gate.pending[0]!.id, "allow");
    await expect(link).resolves.toBeUndefined();
    expect(page.services.openLink).toHaveBeenCalledWith("https://example.com/x");

    const ai = page.paseo.ai("2+2?", { maxTokens: 10 });
    await tick();
    page.gate.decide(page.gate.pending[0]!.id, "allow");
    await expect(ai).resolves.toBe("42");
  });

  it("rejects with the host's message when denied or refused", async () => {
    const page = openPage();
    await page.paseo.ready;
    const pending = page.paseo.sendMessage("x");
    await tick();
    page.gate.decide(page.gate.pending[0]!.id, "cancel");
    await expect(pending).rejects.toThrow("denied by the user");
    await expect(page.paseo.openLink("http://insecure.example.com")).rejects.toThrow(/https/);
    await expect(page.paseo.storage.get("")).rejects.toMatchObject({ code: -32602 });
  });

  it("requestDisplayMode resolves the mode actually set", async () => {
    const page = openPage();
    await page.paseo.ready;
    await expect(page.paseo.requestDisplayMode("fullscreen")).resolves.toBe("fullscreen");
  });

  it("download passes the file through", async () => {
    const page = openPage();
    await page.paseo.ready;
    await page.paseo.download({ filename: "a.txt", mimeType: "text/plain", text: "hi" });
    expect(page.services.download).toHaveBeenCalledWith({ filename: "a.txt", mimeType: "text/plain", text: "hi", base64: undefined });
  });

  it("applies host-context-changed to the root style and calls onContextChange", async () => {
    const page = openPage();
    await page.paseo.ready;
    const seen: any[] = [];
    const off = page.paseo.onContextChange((ctx: any) => seen.push(ctx));
    page.bridge.notifyHostContext({ theme: "dark", styles: { variables: { "--background": "#000000" } } });
    await tick();
    expect(page.style["--background"]).toBe("#000000");
    expect(seen).toHaveLength(1);
    expect(seen[0].theme).toBe("dark");
    expect(page.paseo.context.styles.variables["--foreground"]).toBe("#111111");
    off();
    page.bridge.notifyHostContext({ theme: "light" });
    await tick();
    expect(seen).toHaveLength(1);
  });

  it("answers resource-teardown and runs onTeardown", async () => {
    const page = openPage();
    await page.paseo.ready;
    const torn = vi.fn();
    page.paseo.onTeardown(torn);
    const done = page.bridge.teardown("fullscreen");
    await tick();
    await done;
    expect(torn).toHaveBeenCalledWith({ reason: "fullscreen" });
    expect(page.sent.some((m) => m.result !== undefined && String(m.id).startsWith("paseo-teardown"))).toBe(true);
  });

  it("ignores messages that do not come from the parent window", async () => {
    const page = openPage();
    await page.paseo.ready;
    const seen: any[] = [];
    page.paseo.onContextChange((ctx: any) => seen.push(ctx));
    page.deliver({ jsonrpc: "2.0", method: "ui/notifications/host-context-changed", params: { theme: "dark" } }, { other: true });
    await tick();
    expect(seen).toHaveLength(0);
    expect(page.paseo.context.theme).toBe("light");
  });

  it("answers host requests it does not know with -32601", async () => {
    const page = openPage();
    await page.paseo.ready;
    page.deliver({ jsonrpc: "2.0", id: "h1", method: "something/else" });
    await tick();
    expect(page.sent.at(-1)).toMatchObject({ jsonrpc: "2.0", id: "h1", error: { code: -32601 } });
  });
});

describe("buildPageHtml", () => {
  it("genui: base styles, theme variables, the client, then the page verbatim", () => {
    const html = buildPageHtml('<meta name="paseo-app-id" content="x"><p>hi</p>', theme, "genui");
    const order = [html.indexOf("box-sizing"), html.indexOf('id="genui-theme"'), html.indexOf("window.paseo"), html.indexOf("<p>hi</p>")];
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("--foreground:#111111");
  });

  it("mcp: the page verbatim, nothing injected", () => {
    expect(buildPageHtml("<p>hi</p>", theme, "mcp")).toBe("<p>hi</p>");
  });

  it("strips characters that could break out of the theme style", () => {
    const evil = { colors: { ...theme.colors, foreground: "red;}</style><script>x</script>" } };
    const html = buildPageHtml("", evil, "genui");
    expect(html).not.toContain("</style><script>x");
    expect(html).toContain("--foreground:red/stylescriptx/script");
  });
});
