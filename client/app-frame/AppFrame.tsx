import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl, usePaseo, useRpc, useSettings } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { Modal } from "@getpaseo/plugin/client/ui";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, Share, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import {
  appAiRpc,
  appApprovalsRpc,
  appDownloadRpc,
  appLoadRpc,
  appStorageRpc,
  type AppApprovals,
  type ApprovalKind,
} from "../../shared/app-rpc";
import {
  APP_LIMITS,
  connectKey,
  deriveAppKey,
  htmlFingerprint,
  mcpAppKey,
  sanitizeFilename,
  utf8ByteLength,
} from "../../shared/app-util";
import { genuiSettings } from "../../shared/settings";
import { downloadInBrowser } from "../web";
import type { JsonValue } from "../../shared/json";
import { createAppBridge, type AppBridge, type BridgeServices, type DownloadFile, type McpAppsServices } from "./bridge";
import { createConsentGate, type ConsentGate } from "./consent";
import { ConnectApprovalCard, ConsentBanner } from "./consent-ui";
import { buildHostContext, buildStyleVariables, themeScheme, type AppMode, type HostPlatform } from "./host-context";
import { HostFrame, frameSupport, type HtmlFrameCsp, type HtmlFrameHandle } from "./host-frame";
import { buildPageHtml } from "./page";
import { isAlwaysApproved, resolvePolicy, startsWithoutTap } from "./policy";
import type { DisplayMode } from "./protocol";

/** The plugin SDK exposes no host version; this is the lowest Paseo the plugin supports. */
const HOST_VERSION = "0.14.0";
const DEFAULT_HEIGHT = 180;

/** MCP-mode inputs (slice C). They may be passed flat or grouped under `mcp`. */
export interface AppFrameMcpProps {
  /** MCP server name, as the tool_call item names it. */
  server?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** A CallToolResult: `{content, structuredContent?, isError?, _meta?}`. Sent as `ui/notifications/tool-result`. */
  toolResult?: unknown;
  /** Set when the tool call was cancelled: sent as `ui/notifications/tool-cancelled`. */
  toolCancelled?: string;
  /** The `ui://` resource the html came from (part of the app key). */
  resourceUri?: string;
  /** `tools/call` and `resources/read` through slice C's RPCs. Without it those requests fail. */
  services?: McpAppsServices;
}

export interface AppFrameProps extends AppFrameMcpProps {
  html: string;
  mode: "genui" | "mcp";
  agentId: string;
  /** genui: derived from `<meta name="paseo-app-id">` or the HTML hash when omitted. mcp: `mcp:<server>:<resourceUri>`. */
  appKey?: string;
  /** mcp: the resource's `_meta.ui.csp` (`frameDomains` and `baseUriDomains` are ignored). */
  csp?: { connectDomains?: readonly string[]; resourceDomains?: readonly string[] } | undefined;
  theme: PluginTheme;
  platform: HostPlatform;
  mcp?: AppFrameMcpProps;
}

/** Hosts the user said "Run without network" to, so scrolling a long chat does not ask again. */
const deniedConnects = new Set<string>();

const EMPTY_APPROVALS: AppApprovals = { connect: [], always: [] };

function useApprovals(agentId: string, appKey: string, enabled: boolean) {
  const rpc = useRpc(appApprovalsRpc);
  const [state, setState] = useState<{ key: string; value: AppApprovals } | null>(null);
  const id = `${agentId}\n${appKey}`;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    rpc({ agentId, appKey, action: { type: "get" } }).then(
      (value) => {
        if (!cancelled) setState({ key: id, value });
      },
      () => {
        if (!cancelled) setState({ key: id, value: EMPTY_APPROVALS });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [rpc, agentId, appKey, enabled, id]);

  const ready = !enabled || state?.key === id;
  const value = state?.key === id ? state.value : EMPTY_APPROVALS;

  const approveConnect = useCallback(
    (domains: readonly string[]) => {
      setState({ key: id, value: { ...value, connect: [...value.connect, connectKey(domains)] } });
      void rpc({ agentId, appKey, action: { type: "approveConnect", domains: [...domains] } }).then(
        (next) => setState({ key: id, value: next }),
        () => undefined,
      );
    },
    [rpc, agentId, appKey, id, value],
  );

  const always = useCallback(
    (kind: ApprovalKind, htmlHash: string) => {
      setState((previous) =>
        previous?.key === id
          ? { key: id, value: { ...previous.value, always: [...previous.value.always, { kind, htmlHash }] } }
          : previous,
      );
      void rpc({ agentId, appKey, action: { type: "always", kind, htmlHash } }).then(
        (next) => setState({ key: id, value: next }),
        () => undefined,
      );
    },
    [rpc, agentId, appKey, id],
  );

  return { ready, value, approveConnect, always };
}

function unwrap<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  if (!result.ok) throw new Error((result as unknown as { error: string }).error);
  return result as Extract<T, { ok: true }>;
}

function Placeholder({ theme, height, children }: { theme: PluginTheme; height?: number; children: string }) {
  return (
    <View style={{ minHeight: height, justifyContent: "center" }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>{children}</Text>
    </View>
  );
}

/** A phone with "Run apps automatically on the phone" off: the app stays unmounted until this is tapped. */
function RunAppCard({ theme, onRun }: { theme: PluginTheme; onRun(): void }) {
  return (
    <View style={{ gap: 8, paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12.5 }}>Interactive app, not running yet.</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Run app"
        onPress={onRun}
        style={{ alignSelf: "flex-start", paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, backgroundColor: theme.colors.accent }}
      >
        <Text style={{ color: theme.colors.accentForeground, fontSize: 12.5, fontWeight: "600" }}>Run app</Text>
      </Pressable>
    </View>
  );
}

interface SurfaceProps extends AppFrameProps {
  displayMode: "inline" | "fullscreen";
  /** Switches the app between the card and the fullscreen modal; returns the mode actually set. */
  onRequestDisplayMode(mode: "inline" | "fullscreen"): DisplayMode;
  onHeight(height: number): void;
}

/** One mounted app: frame, bridge, consent and approvals. Remounted when the display mode changes. */
function AppSurface(props: SurfaceProps) {
  const { html, theme, agentId, platform, displayMode, onHeight } = props;
  const mcp = props.mcp ?? props;
  const mode: AppMode = props.mode;
  const fill = displayMode === "fullscreen";
  const paseo = usePaseo();
  const toast = useToast();
  const window = useWindowDimensions();
  const settings = useSettings(genuiSettings);
  const storageRpc = useRpc(appStorageRpc);
  const loadRpc = useRpc(appLoadRpc);
  const downloadRpc = useRpc(appDownloadRpc);
  const aiRpc = useRpc(appAiRpc);

  const key = useMemo(
    () => props.appKey ?? (mode === "genui" ? deriveAppKey(html) : mcpAppKey(mcp.server ?? "", mcp.resourceUri ?? "")),
    [props.appKey, mode, html, mcp.server, mcp.resourceUri],
  );
  const htmlHash = useMemo(() => htmlFingerprint(html), [html]);
  // MCP connect approvals are per server; every other approval is per app.
  const connectScope = mode === "mcp" ? `mcp:${mcp.server ?? ""}` : key;
  const appApprovals = useApprovals(agentId, key, true);
  const scopeApprovals = useApprovals(agentId, connectScope, connectScope !== key);
  const scope = connectScope === key ? appApprovals : scopeApprovals;

  const settingsReady = settings.status !== "loading";
  const allowCdn = settings.status === "ready" ? settings.values.allowCdnLibraries : true;
  const allowAi = settings.status === "ready" ? settings.values.allowAppAi : true;

  // --- CSP ---------------------------------------------------------------------------------
  const policy = useMemo(
    () => resolvePolicy({ mode, html, csp: props.csp, allowCdn, approvedConnect: scope.value.connect }),
    [mode, html, props.csp, allowCdn, scope.value.connect],
  );
  const { requested, requestedKey, approved, resourceDomains, connectDomains } = policy;
  const deniedId = `${agentId}\n${connectScope}\n${requestedKey}`;
  const [, bump] = useState(0);
  const denied = !approved && deniedConnects.has(deniedId);
  const needsConnectDecision = !approved && !denied;

  const frameCsp = useMemo<HtmlFrameCsp>(
    () => ({ resourceDomains, connectDomains }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resourceDomains.join(" "), connectDomains.join(" ")],
  );

  // The theme at mount is baked into the page; later theme changes arrive as host-context-changed.
  const initialTheme = useRef(theme);
  const pageHtml = useMemo(() => buildPageHtml(html, initialTheme.current, mode), [html, mode]);

  // --- The bridge outlives renders; it reads the newest closures through `latest` --------------
  const frameRef = useRef<HtmlFrameHandle | null>(null);
  const sessionRef = useRef<{ bridge: AppBridge; gate: ConsentGate } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizeHint, setSizeHint] = useState<number | null>(null);
  const latestTheme = useRef(theme);
  latestTheme.current = theme;
  const latestWindow = useRef(window);
  latestWindow.current = window;

  const toolSignature = useMemo(
    () => (mode === "mcp" ? JSON.stringify([mcp.toolCancelled ?? null, mcp.toolResult ?? null]) : ""),
    [mode, mcp.toolCancelled, mcp.toolResult],
  );
  const sentToolSignature = useRef("");

  const live: BridgeServices = {
    sendMessage: async (text) => {
      await paseo.agents.ref(agentId).send(text);
    },
    openLink: (url) => openExternalUrl(url),
    requestDisplayMode: (requestedMode) => {
      if (requestedMode === displayMode) return displayMode;
      const current = sessionRef.current;
      if (current === null) return displayMode;
      void current.bridge.teardown("display-mode", 300).then(() => props.onRequestDisplayMode(requestedMode));
      return requestedMode;
    },
    setSize: setSizeHint,
    log: (level, text) => console.debug(`[genui-app ${key}] ${level}: ${text}`),
    storage: {
      get: async (storageKey) => unwrap(await storageRpc({ agentId, appKey: key, op: { type: "get", key: storageKey } })).value,
      set: async (storageKey, value) => {
        unwrap(await storageRpc({ agentId, appKey: key, op: { type: "set", key: storageKey, value } }));
      },
      delete: async (storageKey) => {
        unwrap(await storageRpc({ agentId, appKey: key, op: { type: "delete", key: storageKey } }));
      },
      keys: async () => unwrap(await storageRpc({ agentId, appKey: key, op: { type: "keys" } })).keys ?? [],
    },
    load: async (path) => unwrap(await loadRpc({ agentId, path })).value,
    download: async (file) => {
      const filename = sanitizeFilename(file.filename);
      if (platform === "web") {
        if (!downloadInBrowser({ ...file, filename })) throw new Error("downloads are not available here");
        toast.show(`Downloaded ${filename}`, { variant: "success" });
        return;
      }
      const saved = unwrap(await downloadRpc({ agentId, filename, mimeType: file.mimeType, text: file.text, base64: file.base64 }));
      toast.show(`Saved ${saved.path}`, { variant: "success" });
      if (file.text !== undefined && utf8ByteLength(file.text) <= APP_LIMITS.shareTextBytes) {
        await Share.share({ message: file.text, title: filename }).catch(() => undefined);
      }
    },
    ai: async (request) =>
      unwrap(
        await aiRpc({
          agentId,
          appKey: key,
          prompt: request.prompt,
          ...(request.system === undefined ? {} : { system: request.system }),
          ...(request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens }),
        }),
      ).text,
    ...(mcp.services === undefined ? {} : { mcp: mcp.services }),
  };

  const latest = useRef<{
    isAlways(kind: ApprovalKind): boolean;
    persistAlways(kind: ApprovalKind): void;
    services: BridgeServices;
    sendTool(): void;
  } | null>(null);
  latest.current = {
    isAlways: (kind) => isAlwaysApproved(appApprovals.value, kind, htmlHash),
    persistAlways: (kind) => appApprovals.always(kind, htmlHash),
    services: live,
    sendTool: () => {
      const bridge = sessionRef.current?.bridge;
      if (bridge === undefined || mode !== "mcp") return;
      if (mcp.toolInput !== undefined) bridge.sendToolInput(mcp.toolInput);
      if (mcp.toolCancelled !== undefined) bridge.sendToolCancelled(mcp.toolCancelled);
      else if (mcp.toolResult !== undefined) bridge.sendToolResult(mcp.toolResult);
      sentToolSignature.current = toolSignature;
    },
  };

  const ready = settingsReady && appApprovals.ready && scope.ready;
  const hasMcpServices = mcp.services !== undefined;
  const frameKey = [key, htmlHash, mode, displayMode, frameCsp.connectDomains?.join(" "), frameCsp.resourceDomains?.join(" "), allowAi, hasMcpServices, ready].join("|");

  const session = useMemo(() => {
    const gate = createConsentGate({
      isAlways: (kind) => latest.current?.isAlways(kind) ?? false,
      persistAlways: (kind) => latest.current?.persistAlways(kind),
    });
    const current = (): BridgeServices => latest.current!.services;
    const services: BridgeServices = {
      sendMessage: (text) => current().sendMessage(text),
      openLink: (url) => current().openLink(url),
      requestDisplayMode: (requestedMode) => current().requestDisplayMode(requestedMode),
      setSize: (height) => current().setSize(height),
      log: (level, text) => current().log(level, text),
      ...(mode === "genui"
        ? {
            storage: {
              get: (storageKey: string) => current().storage!.get(storageKey),
              set: (storageKey: string, value: JsonValue) => current().storage!.set(storageKey, value),
              delete: (storageKey: string) => current().storage!.delete(storageKey),
              keys: () => current().storage!.keys(),
            },
            load: (path: string) => current().load!(path),
            download: (file: DownloadFile) => current().download!(file),
            ...(allowAi ? { ai: (request: Parameters<NonNullable<BridgeServices["ai"]>>[0]) => current().ai!(request) } : {}),
          }
        : {}),
      ...(mode === "mcp" && hasMcpServices
        ? {
            mcp: {
              callTool: (request: Parameters<McpAppsServices["callTool"]>[0]) => current().mcp!.callTool(request),
              readResource: (request: Parameters<McpAppsServices["readResource"]>[0]) => current().mcp!.readResource(request),
            },
          }
        : {}),
    };
    const bridge = createAppBridge({
      mode,
      version: HOST_VERSION,
      getHostContext: () =>
        buildHostContext({
          theme: latestTheme.current,
          mode,
          displayMode,
          platform,
          ...(displayMode === "fullscreen" ? { container: { width: latestWindow.current.width, height: latestWindow.current.height } } : {}),
          maxInlineHeight: APP_LIMITS.maxHeight,
          ...(mcp.toolName === undefined ? {} : { toolName: mcp.toolName }),
          version: HOST_VERSION,
        }),
      approvedDomains: () => ({ connectDomains: frameCsp.connectDomains ?? [], resourceDomains: frameCsp.resourceDomains ?? [] }),
      post: (message) => frameRef.current?.postMessage(message),
      services,
      consent: (request) => gate.request(request),
      onInitialized: () => latest.current?.sendTool(),
    });
    return { gate, bridge };
    // The session is rebuilt exactly when the page is remounted (frameKey).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameKey]);
  sessionRef.current = session;

  useEffect(
    () => () => {
      void session.bridge.teardown("unmount", 0);
      session.gate.cancelAll();
      session.bridge.dispose();
    },
    [session],
  );

  const themeKey = JSON.stringify(theme.colors);
  useEffect(() => {
    if (!session.bridge.initialized) return;
    session.bridge.notifyHostContext({ theme: themeScheme(theme), styles: { variables: buildStyleVariables(theme, mode) } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey, session]);

  // A tool result that arrives or changes after the page started is delivered once; the first
  // delivery happens when the page says it is initialized (onInitialized above).
  useEffect(() => {
    if (mode !== "mcp" || !session.bridge.initialized || sentToolSignature.current === toolSignature) return;
    sentToolSignature.current = toolSignature;
    if (mcp.toolCancelled !== undefined) session.bridge.sendToolCancelled(mcp.toolCancelled);
    else if (mcp.toolResult !== undefined) session.bridge.sendToolResult(mcp.toolResult);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toolSignature, session]);

  const onMessage = useCallback((message: unknown) => session.bridge.handle(message), [session]);
  const onContentHeight = useCallback((height: number) => onHeight(height), [onHeight]);

  if (!ready) return <Placeholder theme={theme} height={DEFAULT_HEIGHT}>Loading app…</Placeholder>;

  if (needsConnectDecision) {
    return (
      <ConnectApprovalCard
        domains={requested.valid}
        rejected={requested.rejected}
        theme={theme}
        onAllow={() => scope.approveConnect(requested.valid)}
        onDeny={() => {
          deniedConnects.add(deniedId);
          bump((count) => count + 1);
        }}
      />
    );
  }

  return (
    <View style={fill ? { flex: 1 } : { gap: 8 }}>
      <ConsentBanner gate={session.gate} theme={theme} />
      <View style={fill ? { flex: 1 } : undefined}>
        <HostFrame
          key={frameKey}
          ref={frameRef}
          html={pageHtml}
          csp={frameCsp}
          autoHeight={fill ? false : { min: APP_LIMITS.minHeight, max: APP_LIMITS.maxHeight }}
          height={sizeHint ?? DEFAULT_HEIGHT}
          fill={fill}
          scrollEnabled={fill}
          onMessage={onMessage}
          onContentHeight={onContentHeight}
          onError={setError}
        />
      </View>
      {error !== null ? <Text style={{ color: theme.colors.statusDanger, fontSize: 11.5 }}>{error}</Text> : null}
    </View>
  );
}

/**
 * Renders one app: an HTML page in a sandboxed frame with the MCP Apps host bridge (genui mode adds
 * `window.paseo`), consent banners, per-app approvals, and a fullscreen button. See docs/inline-apps/SPEC.md.
 */
export function AppFrame(props: AppFrameProps) {
  const { theme, platform } = props;
  const [fullscreen, setFullscreen] = useState(false);
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [tapped, setTapped] = useState(false);
  const settings = useSettings(genuiSettings);
  const supported = frameSupport() !== "none";

  const onRequestDisplayMode = useCallback(
    (requested: "inline" | "fullscreen"): DisplayMode => {
      if (requested === "fullscreen" && !supported) return "inline";
      setFullscreen(requested === "fullscreen");
      return requested;
    },
    [supported],
  );

  // On a phone, wait for the setting rather than guess; if it cannot be read, the default (on) applies.
  const autoRun = settings.status === "ready" ? settings.values.autoRunAppsOnPhone : true;
  const phoneSettingsPending = platform !== "web" && settings.status === "loading";

  if (!supported) {
    return (
      <View style={{ gap: 6 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          Interactive HTML app (open on desktop or web to run):
        </Text>
        <Text selectable style={{ color: theme.colors.foreground, fontFamily: "monospace", fontSize: 11.5 }}>
          {props.html}
        </Text>
      </View>
    );
  }

  return (
    <>
      <View style={{ gap: 6 }}>
        {fullscreen ? (
          <Placeholder theme={theme} height={height}>Open in fullscreen</Placeholder>
        ) : phoneSettingsPending ? (
          <Placeholder theme={theme} height={DEFAULT_HEIGHT}>Loading app…</Placeholder>
        ) : tapped || startsWithoutTap(platform, autoRun) ? (
          <AppSurface {...props} displayMode="inline" onRequestDisplayMode={onRequestDisplayMode} onHeight={setHeight} />
        ) : (
          <RunAppCard theme={theme} onRun={() => setTapped(true)} />
        )}
        {!fullscreen ? (
          <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open app fullscreen"
              onPress={() => setFullscreen(true)}
              style={{ flexDirection: "row", alignItems: "center", gap: 4 }}
            >
              <Icon name="Maximize2" size={11} color={theme.colors.foregroundMuted} />
              <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>Fullscreen</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {fullscreen ? (
        <Modal title="App" open onOpenChange={(open) => !open && setFullscreen(false)}>
          <Modal.Content scrollable={false} style={{ flex: 1 }} contentContainerStyle={{ flex: 1, padding: 0, gap: 0 }}>
            <View style={{ flex: 1, borderTopWidth: StyleSheet.hairlineWidth, borderColor: theme.colors.border }}>
              <AppSurface {...props} displayMode="fullscreen" onRequestDisplayMode={onRequestDisplayMode} onHeight={setHeight} />
            </View>
          </Modal.Content>
        </Modal>
      ) : null}
    </>
  );
}
