import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { CDN_ALLOWLIST, deriveAppKey } from "../../shared/app-util";
import { APP_INSTRUCTIONS } from "../../shared/instructions";
import { createAppBridge, type AppBridge, type BridgeServices } from "./bridge";
import { createConsentGate, type ConsentGate } from "./consent";
import { buildHostContext, paseoVariables } from "./host-context";
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

/** `window.paseo` as the injected client builds it, with a parent that answers nothing. */
function injectedPaseo(): any {
  const window: any = { parent: { postMessage() {} }, addEventListener() {} };
  const document = { documentElement: { style: { setProperty() {} }, dataset: {} } };
  vm.runInContext(PASEO_CLIENT_SOURCE, vm.createContext({ window, document, Object, Promise, Error }));
  return window.paseo;
}

/** Distinct `paseo.<name>` references in a text, e.g. `storage.get` for `paseo.storage.get(key)`. */
function paseoNames(text: string): string[] {
  return [...new Set([...text.matchAll(/\bpaseo\.([A-Za-z]\w*(?:\.[A-Za-z]\w*)*)/g)].map((match) => match[1]!))];
}

/** The value at a dotted path of the client, or undefined when the client has no such name. */
function apiAt(root: unknown, dotted: string): unknown {
  let current: unknown = root;
  for (const part of dotted.split(".")) {
    if (typeof current !== "object" || current === null || !(part in current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

describe("```app instructions against the injected client", () => {
  /** Values and namespaces, not functions: `ready` and `context` are data, `storage` holds the storage calls. */
  const values = new Set(["ready", "context", "storage"]);

  it("name only window.paseo API that the client implements", () => {
    const names = paseoNames(APP_INSTRUCTIONS);
    expect(names).toEqual(
      expect.arrayContaining([
        "ready",
        "context",
        "onContextChange",
        "storage.get",
        "storage.set",
        "storage.delete",
        "storage.keys",
        "sendMessage",
        "openLink",
        "requestDisplayMode",
        "load",
        "download",
        "ai",
      ]),
    );
    const paseo = injectedPaseo();
    for (const name of names) {
      const found = apiAt(paseo, name);
      expect(found, `paseo.${name}`).not.toBeUndefined();
      if (!values.has(name)) expect(typeof found, `paseo.${name}`).toBe("function");
    }
  });

  it("name only CSS variables that the page theme provides", () => {
    const variables = [...new Set(APP_INSTRUCTIONS.match(/--[a-z][a-z-]*[a-z]/g) ?? [])];
    expect(variables.length).toBeGreaterThan(5);
    const provided = Object.keys(paseoVariables(theme));
    for (const name of variables) expect(provided, name).toContain(name);
  });
});

/** Whether a URL sits under one of the CDN allowlist's origins and path prefixes. */
function allowedByCdn(url: string): boolean {
  const target = new URL(url);
  return CDN_ALLOWLIST.some((entry) => {
    const allowed = new URL(entry);
    return target.origin === allowed.origin && target.pathname.startsWith(allowed.pathname);
  });
}

/** Just enough DOM for the example: elements by id, child lists, value and checked, and click or change. */
interface FakeElement {
  id: string;
  type: string;
  className: string;
  value: string;
  checked: boolean;
  textContent: string;
  children: FakeElement[];
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: () => void): void;
  append(...nodes: FakeElement[]): void;
  appendChild(node: FakeElement): FakeElement;
  fire(type: string): void;
}

function fakeDocument(ids: readonly string[]) {
  const byId = new Map<string, FakeElement>();
  function make(id: string): FakeElement {
    const listeners: Record<string, Array<() => void>> = {};
    let text = "";
    const element: FakeElement = {
      id,
      type: "",
      className: "",
      value: "",
      checked: false,
      children: [],
      get textContent() {
        return text;
      },
      set textContent(next: string) {
        text = next;
        if (next === "") element.children = [];
      },
      setAttribute() {},
      addEventListener(type, listener) {
        (listeners[type] ??= []).push(listener);
      },
      append(...nodes) {
        element.children.push(...nodes);
      },
      appendChild(node) {
        element.children.push(node);
        return node;
      },
      fire(type) {
        for (const listener of listeners[type] ?? []) listener();
      },
    };
    return element;
  }
  for (const id of ids) byId.set(id, make(id));
  const document = {
    getElementById(id: string) {
      const found = byId.get(id);
      if (found === undefined) throw new Error(`no element #${id}`);
      return found;
    },
    createElement() {
      return make("");
    },
  };
  return { document, byId };
}

describe("gallery/apps/packing-list.html", () => {
  const source = () => readFile(new URL("../../gallery/apps/packing-list.html", import.meta.url), "utf8");
  /** The page's one inline script, the code that runs after the client is injected. */
  const inlineScript = (html: string) => /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";

  it("follows the ```app instructions: app id, one CDN library, no banned APIs", async () => {
    const html = await source();
    expect(deriveAppKey(html)).toBe("packing-list");
    expect(html.length).toBeLessThan(16_000);
    expect(html).toMatch(/@media/);
    expect(inlineScript(html)).toContain('typeof confetti === "function"');
    expect(() => new vm.Script(inlineScript(html))).not.toThrow();

    const scripts = html.match(/<script\b[^>]*\bsrc=/gi) ?? [];
    expect(scripts).toHaveLength(1);
    const urls = [...html.matchAll(/https:\/\/[^\s"'<>)]+/g)].map((match) => match[0]);
    expect(urls).toHaveLength(1);
    expect(allowedByCdn(urls[0]!)).toBe(true);

    for (const banned of [
      /localStorage|sessionStorage|document\.cookie/,
      /\bfetch\(|XMLHttpRequest|WebSocket|EventSource/,
      /window\.open|<form\b|<iframe\b|<object\b|<embed\b|<a\s|target=/,
      /100vh|100dvh/,
    ]) {
      expect(html, String(banned)).not.toMatch(banned);
    }
  });

  it("uses paseo.storage and paseo.sendMessage, and every paseo name it uses exists in the client", async () => {
    const names = paseoNames(await source());
    expect(names).toEqual(expect.arrayContaining(["storage.get", "storage.set", "sendMessage"]));
    const paseo = injectedPaseo();
    for (const name of names) expect(apiAt(paseo, name), `paseo.${name}`).not.toBeUndefined();
  });

  it("runs against the real client and bridge: saves an item, sends open items after consent, marks packed", async () => {
    const html = await source();
    const ids = [...new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!))];
    for (const lookup of inlineScript(html).matchAll(/getElementById\("([^"]+)"\)/g)) expect(ids).toContain(lookup[1]);

    const sent: string[] = [];
    const page = openPage({ services: { sendMessage: async (text: string) => void sent.push(text) } });
    const { document, byId } = fakeDocument(ids);
    const context = vm.createContext({ window: page.window, paseo: page.paseo, document, Object, Array, Promise, Error, JSON, console });
    vm.runInContext(inlineScript(html), context);
    const settle = async () => {
      for (let round = 0; round < 6; round++) await tick();
    };

    await settle();
    expect(byId.get("count")!.textContent).toBe("No items yet");

    byId.get("name")!.value = "Passport";
    byId.get("add")!.fire("click");
    await settle();
    expect(byId.get("items")!.children).toHaveLength(1);
    expect(await page.paseo.storage.get("items")).toEqual([{ text: "Passport", done: false }]);

    byId.get("send")!.fire("click");
    await settle();
    expect(page.gate.pending).toHaveLength(1);
    page.gate.decide(page.gate.pending[0]!.id, "allow");
    await settle();
    expect(sent).toEqual(["Still to pack:\n- Passport"]);
    expect(byId.get("status")!.textContent).toBe("Sent to the chat.");

    const checkbox = byId.get("items")!.children[0]!.children[0]!;
    checkbox.checked = true;
    checkbox.fire("change");
    await settle();
    expect(byId.get("count")!.textContent).toBe("1 of 1 packed");
    expect(await page.paseo.storage.get("items")).toEqual([{ text: "Passport", done: true }]);
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
