import type { z } from "zod";
import { APP_LIMITS, validateOpenLink } from "../../shared/app-util";
import type { JsonValue } from "../../shared/json";
import type { ConsentOutcome, ConsentRequest } from "./consent";
import { hostCapabilities, type AppMode, type HostContext } from "./host-context";
import {
  PROTOCOL_VERSION,
  RPC_ERROR,
  isRpcError,
  aiParamsSchema,
  describeIssue,
  displayModeParamsSchema,
  downloadParamsSchema,
  errorMessage,
  initializeParamsSchema,
  loadParamsSchema,
  logParamsSchema,
  messageParamsSchema,
  notificationMessage,
  openLinkParamsSchema,
  parseMessage,
  readResourceParamsSchema,
  resultMessage,
  rpcError,
  sizeChangedParamsSchema,
  storageGetParamsSchema,
  storageKeysParamsSchema,
  storageSetParamsSchema,
  toolCallParamsSchema,
  type DisplayMode,
  type RpcId,
} from "./protocol";

/** Slice C's `tools/call` and `resources/read` proxies; AppFrame takes them as a prop. */
export interface McpAppsServices {
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
  readResource(request: { uri: string }): Promise<unknown>;
}

export interface DownloadFile {
  readonly filename: string;
  readonly mimeType: string;
  readonly text?: string | undefined;
  readonly base64?: string | undefined;
}

/** What the host does for a page. Every method may throw; the message reaches the page as a JSON-RPC error. */
export interface BridgeServices {
  sendMessage(text: string): Promise<void>;
  openLink(url: string): Promise<void>;
  /** Returns the mode actually set. */
  requestDisplayMode(mode: "inline" | "fullscreen"): DisplayMode;
  setSize(height: number): void;
  log(level: string, text: string): void;
  storage?: {
    get(key: string): Promise<JsonValue | null>;
    set(key: string, value: JsonValue): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  load?(path: string): Promise<JsonValue>;
  download?(file: DownloadFile): Promise<void>;
  ai?(request: { prompt: string; system?: string | undefined; maxTokens?: number | undefined }): Promise<string>;
  mcp?: McpAppsServices;
}

export interface BridgeOptions {
  readonly mode: AppMode;
  readonly version: string;
  getHostContext(): HostContext;
  /** CSP domains the user approved and the allowlisted resource domains, reported in hostCapabilities. */
  approvedDomains(): { connectDomains: readonly string[]; resourceDomains: readonly string[] };
  /** Delivers one JSON-RPC message to the page. */
  post(message: Record<string, unknown>): void;
  services: BridgeServices;
  consent(request: ConsentRequest): Promise<ConsentOutcome>;
  onInitialized?(): void;
  now?: () => number;
}

function createRateWindow(limit: number, spanMs: number, now: () => number): { tryTake(): boolean } {
  const stamps: number[] = [];
  return {
    tryTake() {
      const cutoff = now() - spanMs;
      while (stamps.length > 0 && (stamps[0] ?? 0) <= cutoff) stamps.shift();
      if (stamps.length >= limit) return false;
      stamps.push(now());
      return true;
    },
  };
}

type Handler = (params: unknown) => unknown | Promise<unknown>;

interface MethodEntry {
  readonly modes: readonly AppMode[];
  /** Allowed before `ui/notifications/initialized`. */
  readonly early?: boolean;
  readonly handler: Handler;
}

const DENIED: Record<ConsentOutcome, string | null> = {
  granted: null,
  denied: "denied by the user",
  timeout: "the user did not answer in time",
  busy: "too many requests are waiting for the user",
};

function parseParams<S extends z.ZodType>(schema: S, params: unknown): z.output<S> {
  const parsed = schema.safeParse(params);
  if (!parsed.success) throw rpcError(RPC_ERROR.invalidParams, describeIssue(parsed.error));
  return parsed.data;
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function assertSendable(value: unknown): void {
  let size: number;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    throw rpcError(RPC_ERROR.failed, "result is not JSON");
  }
  if (size > APP_LIMITS.frameMessageBytes) throw rpcError(RPC_ERROR.failed, "result is over 4 MB");
}

export interface AppBridge {
  /** One message the page posted. Anything that is not valid JSON-RPC is ignored. */
  handle(raw: unknown): void;
  readonly initialized: boolean;
  /** `ui/notifications/host-context-changed`: a partial HostContext, merged by the page. */
  notifyHostContext(patch: Partial<HostContext>): void;
  sendToolInput(args: Record<string, unknown>): void;
  sendToolResult(result: unknown): void;
  sendToolCancelled(reason: string): void;
  /** `ui/resource-teardown`: asks the page to wrap up, waits for its answer (or `waitMs`). */
  teardown(reason: string, waitMs?: number): Promise<void>;
  dispose(): void;
}

/**
 * The host side of the app protocol: JSON-RPC 2.0 over postMessage, the MCP Apps (2026-01-26) wire
 * format, plus `paseo/*` for ```app pages. Framework-free; AppFrame feeds it page messages and gives
 * it `post`. Every page message is parsed with zod, size-capped, rate-limited and, when it acts for
 * the user (message, link, AI), held for consent first.
 *
 * Closures, not `class`: client code runs in Hermes (see shared/hermes-syntax.test.ts).
 */
export function createAppBridge(options: BridgeOptions): AppBridge {
  const { services } = options;
  const now = options.now ?? Date.now;
  const overall = createRateWindow(50, 10_000, now);
  const messages = createRateWindow(1, 3_000, now);
  const downloads = createRateWindow(10, 60_000, now);
  const errorReplies = createRateWindow(200, 10_000, now);
  const hostRequests = new Map<RpcId, () => void>();
  let initializeSeen = false;
  let ready = false;
  let disposed = false;
  let outbox: Array<Record<string, unknown>> = [];
  let teardownSeq = 0;

  function send(message: Record<string, unknown>): void {
    if (disposed) return;
    // The spec forbids host messages before the page's `initialized` notification.
    if (!ready) outbox.push(message);
    else options.post(message);
  }

  function reply(message: Record<string, unknown>): void {
    if (disposed) return;
    options.post(message);
  }

  async function consent(request: ConsentRequest): Promise<void> {
    const outcome = await options.consent(request);
    const refusal = DENIED[outcome];
    if (refusal !== null) throw rpcError(RPC_ERROR.failed, refusal);
  }

  function need<T>(value: T | undefined): T {
    if (value === undefined) throw rpcError(RPC_ERROR.methodNotFound, "not available");
    return value;
  }

  const both: AppMode[] = ["genui", "mcp"];
  const genui: AppMode[] = ["genui"];
  const mcp: AppMode[] = ["mcp"];

  const table: Readonly<Record<string, MethodEntry>> = {
    "ui/initialize": {
      modes: both,
      early: true,
      handler: (params) => {
        parseParams(initializeParamsSchema, params);
        initializeSeen = true;
        return {
          protocolVersion: PROTOCOL_VERSION,
          hostInfo: { name: "Paseo", version: options.version },
          hostCapabilities: hostCapabilities(options.mode, options.approvedDomains(), services.mcp !== undefined),
          hostContext: options.getHostContext(),
        };
      },
    },
    ping: { modes: both, early: true, handler: () => ({}) },
    "ui/notifications/initialized": {
      modes: both,
      handler: () => {
        if (ready) return {};
        ready = true;
        const queued = outbox;
        outbox = [];
        for (const message of queued) options.post(message);
        options.onInitialized?.();
        return {};
      },
    },
    "ui/notifications/size-changed": {
      modes: both,
      handler: (params) => {
        const { height } = parseParams(sizeChangedParamsSchema, params);
        if (height !== undefined && height > 0) {
          services.setSize(Math.min(APP_LIMITS.maxHeight, Math.max(APP_LIMITS.minHeight, Math.ceil(height))));
        }
        return {};
      },
    },
    "notifications/message": {
      modes: both,
      handler: (params) => {
        const { level, logger, data } = parseParams(logParamsSchema, params);
        let text: string;
        try {
          text = typeof data === "string" ? data : (JSON.stringify(data) ?? "");
        } catch {
          text = "[unserializable]";
        }
        services.log(level ?? "info", clip(`${logger ? `${logger}: ` : ""}${text}`, APP_LIMITS.logChars));
        return {};
      },
    },
    "ui/message": {
      modes: both,
      handler: async (params) => {
        const { text } = parseParams(messageParamsSchema, params);
        if (!messages.tryTake()) throw rpcError(RPC_ERROR.failed, "rate limited: one message every 3 seconds");
        await consent({ kind: "message", title: "This app wants to send this message to the chat:", detail: text });
        await services.sendMessage(text);
        return {};
      },
    },
    "ui/open-link": {
      modes: both,
      handler: async (params) => {
        const { url } = parseParams(openLinkParamsSchema, params);
        const safe = validateOpenLink(url);
        if (safe === null) throw rpcError(RPC_ERROR.failed, "only plain https links can be opened");
        await consent({ kind: "link", title: "This app wants to open this link in your browser:", detail: safe });
        await services.openLink(safe);
        return {};
      },
    },
    "ui/request-display-mode": {
      modes: both,
      handler: (params) => {
        const { mode } = parseParams(displayModeParamsSchema, params);
        if (mode === "pip") return { mode: options.getHostContext().displayMode };
        return { mode: services.requestDisplayMode(mode) };
      },
    },
    "tools/call": {
      modes: mcp,
      handler: async (params) => {
        const { name, arguments: args } = parseParams(toolCallParamsSchema, params);
        const result = await need(services.mcp).callTool({ name, arguments: args ?? {} });
        assertSendable(result);
        return result;
      },
    },
    "resources/read": {
      modes: mcp,
      handler: async (params) => {
        const { uri } = parseParams(readResourceParamsSchema, params);
        const result = await need(services.mcp).readResource({ uri });
        assertSendable(result);
        return result;
      },
    },
    "paseo/storage/get": {
      modes: genui,
      handler: async (params) => {
        const { key } = parseParams(storageGetParamsSchema, params);
        return { value: (await need(services.storage).get(key)) ?? null };
      },
    },
    "paseo/storage/set": {
      modes: genui,
      handler: async (params) => {
        const { key, value } = parseParams(storageSetParamsSchema, params);
        await need(services.storage).set(key, value as JsonValue);
        return {};
      },
    },
    "paseo/storage/delete": {
      modes: genui,
      handler: async (params) => {
        const { key } = parseParams(storageGetParamsSchema, params);
        await need(services.storage).delete(key);
        return {};
      },
    },
    "paseo/storage/keys": {
      modes: genui,
      handler: async (params) => {
        parseParams(storageKeysParamsSchema, params);
        return { keys: await need(services.storage).keys() };
      },
    },
    "paseo/load": {
      modes: genui,
      handler: async (params) => {
        const { path } = parseParams(loadParamsSchema, params);
        const value = await need(services.load)(path);
        assertSendable(value);
        return { value };
      },
    },
    "paseo/download": {
      modes: genui,
      handler: async (params) => {
        const file = parseParams(downloadParamsSchema, params);
        if (!downloads.tryTake()) throw rpcError(RPC_ERROR.failed, "rate limited: at most 10 downloads a minute");
        await need(services.download)({
          filename: file.filename,
          mimeType: file.mimeType,
          text: file.text,
          base64: file.base64,
        });
        return {};
      },
    },
    "paseo/ai": {
      modes: genui,
      handler: async (params) => {
        const request = parseParams(aiParamsSchema, params);
        const ai = services.ai;
        if (ai === undefined) throw rpcError(RPC_ERROR.failed, "AI is turned off for apps (Generative UI settings)");
        await consent({
          kind: "ai",
          title: "This app wants to ask Claude Haiku (on your Claude subscription). First request:",
          detail: request.prompt,
        });
        return { text: await ai({ prompt: request.prompt, system: request.system, maxTokens: request.maxTokens }) };
      },
    },
  };

  async function dispatch(id: RpcId | null, method: string, params: unknown): Promise<void> {
    if (!overall.tryTake()) {
      if (id !== null && errorReplies.tryTake()) {
        reply(errorMessage(id, RPC_ERROR.failed, "rate limited: at most 50 requests per 10 seconds"));
      }
      return;
    }
    const entry = Object.hasOwn(table, method) ? table[method] : undefined;
    if (entry === undefined || !entry.modes.includes(options.mode)) {
      if (id !== null) reply(errorMessage(id, RPC_ERROR.methodNotFound, `method not found: ${clip(method, 60)}`));
      return;
    }
    if (!entry.early && !initializeSeen) {
      if (id !== null) reply(errorMessage(id, RPC_ERROR.notInitialized, "send ui/initialize first"));
      return;
    }
    try {
      const result = await entry.handler(params);
      if (id !== null) reply(resultMessage(id, result ?? {}));
    } catch (cause) {
      if (id === null) return;
      if (isRpcError(cause)) reply(errorMessage(id, cause.code, cause.message));
      else reply(errorMessage(id, RPC_ERROR.failed, clip(cause instanceof Error ? cause.message : "request failed", 200)));
    }
  }

  return {
    handle(raw) {
      if (disposed) return;
      const message = parseMessage(raw);
      switch (message.kind) {
        case "ignore":
          return;
        case "invalid":
          if (message.id !== null) reply(errorMessage(message.id, RPC_ERROR.invalidRequest, "invalid request"));
          return;
        case "response": {
          const waiting = hostRequests.get(message.id);
          if (waiting !== undefined) {
            hostRequests.delete(message.id);
            waiting();
          }
          return;
        }
        case "request":
          void dispatch(message.id, message.method, message.params);
          return;
        case "notification":
          void dispatch(null, message.method, message.params);
      }
    },
    get initialized() {
      return ready;
    },
    notifyHostContext(patch) {
      send(notificationMessage("ui/notifications/host-context-changed", patch));
    },
    sendToolInput(args) {
      if (options.mode === "mcp") send(notificationMessage("ui/notifications/tool-input", { arguments: args }));
    },
    sendToolResult(result) {
      if (options.mode === "mcp") send(notificationMessage("ui/notifications/tool-result", result));
    },
    sendToolCancelled(reason) {
      if (options.mode === "mcp") send(notificationMessage("ui/notifications/tool-cancelled", { reason }));
    },
    async teardown(reason, waitMs = 400) {
      if (!ready || disposed) return;
      const id = `paseo-teardown-${++teardownSeq}`;
      const answered = new Promise<void>((resolve) => {
        hostRequests.set(id, resolve);
        setTimeout(() => {
          hostRequests.delete(id);
          resolve();
        }, waitMs);
      });
      options.post({ jsonrpc: "2.0", id, method: "ui/resource-teardown", params: { reason } });
      await answered;
    },
    dispose() {
      disposed = true;
      outbox = [];
      hostRequests.clear();
    },
  };
}
