# Inline apps on every surface: spec (2026-11-21)

Goal: ```app blocks and MCP Apps tool views render as full HTML/CSS/JS apps on web, desktop,
mobile web AND the native iOS/Android app, with an MCP Apps compatible host bridge and
parity with Claude artifacts / ChatGPT Apps where it is safe.

Three work slices, each owned by one builder. Interfaces below are contracts: do not change
them without asking the coordinator (the agent that briefed you).

- **A. Paseo core `HtmlFrame`** (repo `Brandon168/paseo`, Paseo worktree): a sandboxed HTML view
  exposed to plugins next to the existing `DocumentFrame`.
- **B. genui host bridge** (repo `Brandon168/paseo-plugin-genui`, branch off `paseo-fix`):
  `AppFrame`, JSON-RPC bridge, consent UI, storage/load/download/AI server RPCs, ```app wiring.
- **C. genui MCP Apps discovery** (same genui repo, separate branch, separate files): MCP
  server discovery, tool → UI resource lookup, proxied `tools/call` / `resources/read`,
  `tool_call` timeline transformer + renderer wiring onto B's `AppFrame`.
- **D. genui docs/instructions/settings** (after B lands): agent instructions, settings, docs, gallery.

Threat model (read this first): the HTML is written by an LLM agent that also reads untrusted
email and web pages, or by a third-party MCP server. Treat every page as hostile. The page
must never get open network egress, host storage, cookies, credentials, or the ability to act
(send messages, open links, call AI, call tools) without the user's consent or a declared,
user-approved scope. Every message from a page is untrusted input: validate with zod, cap sizes,
ignore unknown shapes.

---

## A. Core: `HtmlFrame` (Paseo app + plugin SDK)

Precedent: `packages/app/src/file-panels/document-frame` (already exported to plugins as
`DocumentFrame` from `@getpaseo/plugin/client/ui`), `file-panels/html-preview.tsx` +
`html-preview-csp.ts` + `html-preview-navigation.ts` (hardened WebView), and the Mermaid fence
host (`components/markdown/fence/mermaid/host.native.tsx`, `iframe-runtime.web.tsx`), which
already does sandboxed page + postMessage + height reporting on both platforms. Reuse these;
do not invent a second hardening scheme.

### API (add to `packages/plugin/src/client/ui.ts` types and `packages/app/src/plugins/react-native/ui.ts` runtime)

```ts
export interface HtmlFrameCsp {
  /** Origins (optionally with a path prefix ending in "/") the page may load scripts,
   *  styles, images, fonts and media from. Only "https://host[:port][/path/]" with an
   *  optional leading "*." on the host. Anything else is dropped (onError reports it). */
  resourceDomains?: readonly string[];
  /** Origins the page may reach with fetch/XHR/WebSocket/EventSource. "https://..." or
   *  "wss://...", same rules. Default: none. */
  connectDomains?: readonly string[];
}

export interface HtmlFrameHandle {
  /** Deliver a JSON-serializable value to the page as a MessageEvent. */
  postMessage(message: unknown): void;
}

export interface HtmlFrameProps {
  /** A full document or a fragment. The host supplies doctype + CSP + viewport first. */
  html: string;
  csp?: HtmlFrameCsp;
  /** Auto-size to content (default { min: 80, max: 1400 }); false = use `height`. */
  autoHeight?: { min?: number; max?: number } | false;
  /** Fixed height in px when autoHeight is false (or the initial height before the first measure). */
  height?: number;
  /** Fill the parent (flex: 1), for fullscreen hosts. Overrides height/autoHeight sizing. */
  fill?: boolean;
  /** Inner scrolling. Default false when auto-sizing inline, true when `fill`. */
  scrollEnabled?: boolean;
  /** When false the native view is unmounted and a same-size placeholder kept (memory). Default true. */
  active?: boolean;
  onContentHeight?(height: number): void;
  /** Every JSON value the page posts with window.parent.postMessage (internal measure messages excluded). */
  onMessage?(message: unknown): void;
  /** Script errors in the page and dropped CSP entries. */
  onError?(message: string): void;
  onLoad?(): void;
  testID?: string;
}

export declare const HtmlFrame: ForwardRefExoticComponent<HtmlFrameProps & RefAttributes<HtmlFrameHandle>>;
```

### Page environment (identical on web, desktop, iOS, Android)

1. The host builds the document: `<!doctype html>`, then the CSP `<meta http-equiv>` (must be the
   first element, see html-preview-csp.ts for why), then
   `<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`, a
   base style `html{-webkit-text-size-adjust:100%}`, the host bootstrap script, then the page's
   html verbatim.
2. CSP = the html-preview POLICY (default-src 'none'; inline + eval scripts; inline styles;
   data:/blob: images, fonts, media; connect-src 'none'; form-action 'none'; base-uri 'none';
   frame-src 'none'; object-src 'none') with `resourceDomains` appended to script-src,
   style-src, img-src, font-src, media-src and `connectDomains` replacing connect-src 'none'.
   Domain validation lives in one tested pure function.
3. `document.documentElement.dataset.paseoPlatform = "ios" | "android" | "web"`.
4. Messaging, page → host: `window.parent.postMessage(value, "*")` on every platform. On native
   the bootstrap installs a shim so this reaches `window.ReactNativeWebView.postMessage`
   (JSON-encoded) and so MCP Apps SDK `PostMessageTransport` works unchanged. Host → page:
   `ref.postMessage(value)` arrives as a `message` event whose `data` is the value and whose
   `source === window.parent` (the shim must make that comparison true on native). JSON values
   only, 4 MB cap per message each way (drop + onError beyond it).
5. Auto-height: the bootstrap measures (ResizeObserver on html and body; Math.ceil of max(html
   rect height, body scrollHeight)) and posts an internal message; the host clamps to
   [min, max] and resizes. Internal messages use a private marker and never reach onMessage.
6. Navigation: only the initial document loads. Every later navigation, popup, window.open,
   meta refresh, link click is refused (native: reuse useHtmlPreviewNavigationGuard + inert
   `about:blank` base URL; web: `sandbox="allow-scripts"` iframe with `srcdoc`, no
   allow-same-origin / allow-popups / allow-forms / allow-downloads / allow-top-navigation).
   Hosts implement "open link" through messages.
7. No storage, cookies or cache: native `incognito`, `domStorageEnabled={false}`,
   `cacheEnabled={false}`, `thirdPartyCookiesEnabled={false}`, `setSupportMultipleWindows={false}`,
   `javaScriptCanOpenWindowsAutomatically={false}`; web: opaque origin, `referrerPolicy="no-referrer"`.
   Native media: `allowsInlineMediaPlayback`, `mediaPlaybackRequiresUserAction`. No camera/mic
   permission grants in this version.
8. Native: `scrollEnabled` per prop, `bounces={false}`, transparent background, no zoom.
9. `active={false}`: unmount the native view / iframe, keep a placeholder of the last height.

### Checks for A

- Web/Electron: a `srcdoc` iframe inherits the embedding page's CSP. Confirm the web UI and the
  desktop (Electron) renderer don't set a CSP that would block allowed CDN scripts in the frame;
  if one does, document it and handle it (e.g. note the limitation) rather than loosening Paseo's CSP.
- Unit tests: CSP builder + domain validation (valid, wildcard subdomain, path prefix, http
  rejected, bare "*" rejected, "https:" scheme-only rejected, quotes/semicolons/spaces rejected);
  document assembly (CSP first, BOM handling, platform attribute); message routing (internal
  measure messages filtered, size cap). Browser test for the web iframe if the app's browser test
  setup allows (see `*.browser.test.tsx`). A test of the native bootstrap shim in a DOM env with a
  fake `window.ReactNativeWebView` (parent.postMessage routed, host message arrives with
  `source === window.parent`).
- `npm run typecheck` (or the app's tsgo) on app + plugin packages, lint/format as the repo requires.
  Wrap heavy commands: `systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 ...`.
- FORK.md entry ("Plugin HtmlFrame"), status fork-only, mention Discussions #4867/#5834/#7437.
- Never start a second Paseo daemon or any `opencode` CLI command (it resumes live sessions:
  AI-0064). Do not restart `paseo.service`. Do not deploy.

---

## B. genui host bridge (`client/app-frame/`, `server/app-host/`, `shared/app-rpc.ts`)

### AppFrame

`AppFrame` renders one app. Inputs: `html`, `mode: "genui" | "mcp"`, `agentId`, `appKey` (see
below), `csp`, theme, and for `mcp` mode `{ server, toolName, toolInput, toolResult }`.

- Uses `HtmlFrame` from `@getpaseo/plugin/client/ui` when it exists at runtime
  (`import * as ui from "@getpaseo/plugin/client/ui"; ui.HtmlFrame`). Stock Paseo without it: on
  web keep today's `mountSandboxedAppIframe` path; on native keep today's unsupported message.
- Replaces the current ```app rendering in `client/live-ui.tsx` (`AppBlock`).
- Theme variables injected as today (`buildSrcdoc`'s `--background` etc.).
- Fullscreen: a button on the card and the `ui/request-display-mode` request open the same app
  in the Paseo `Modal` with `HtmlFrame fill`. It remounts; apps keep state through `paseo.storage`.

### Protocol: JSON-RPC 2.0 over postMessage, MCP Apps (spec 2026-01-26) compatible

Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
Read it and match method names, params and result shapes exactly. Supported:

| Method | Dir | genui | mcp | Behaviour |
| --- | --- | --- | --- | --- |
| `ui/initialize` | view→host | yes | yes | hostInfo {name:"Paseo", version}, hostCapabilities (only what we support), hostContext {theme, displayMode, availableDisplayModes ["inline","fullscreen"], containerDimensions, platform, locale, timeZone, styles.variables} |
| `ui/notifications/initialized` | view→host | yes | yes | then host sends tool-input/tool-result (mcp) |
| `ui/notifications/size-changed` | view→host | yes | yes | resize (clamped); HtmlFrame auto-height stays on too |
| `ui/message` | view→host | yes | yes | consent (below), then post as a user message to this agent (same path as the ```ui Send action); 8000 chars max |
| `ui/open-link` | view→host | yes | yes | https only; confirm showing the full URL; then openExternalUrl |
| `ui/request-display-mode` | view→host | yes | yes | inline / fullscreen; returns the mode actually set |
| `ui/notifications/host-context-changed` | host→view | yes | yes | on theme or display-mode change |
| `ui/notifications/tool-input`, `tool-result`, `tool-cancelled` | host→view | no | yes | from the tool_call item |
| `ui/resource-teardown` | host→view | yes | yes | before unmount |
| `tools/call` | view→host | no | yes | proxied through slice C's RPC; only tools the server marks app-visible |
| `resources/read` | view→host | no | yes | proxied through slice C's RPC, same server only |
| `notifications/message` | view→host | yes | yes | log to plugin log, no UI |
| anything else | | | | JSON-RPC error -32601 |

Paseo extensions (genui mode only, namespaced `paseo/`):

| Method | Params | Behaviour |
| --- | --- | --- |
| `paseo/storage/get` / `set` / `delete` / `keys` | `{key}` / `{key, value}` | JSON values persisted on the daemon at `<thread storage>/apps/<appKey>.json`; 1 MB per app; keys ≤ 200 chars |
| `paseo/load` | `{path}` | same roots and parsing as genui's `Load()` (reuse `loadDataRpc` / data-source.ts rules) |
| `paseo/download` | `{filename, mimeType, text? , base64?}` | ≤ 10 MB. Web: browser download from the host page. Native: write to `<thread storage>/downloads/<safe filename>` on the daemon, toast the path, and for text ≤ 100 KB open the share sheet (`Share.share`) |
| `paseo/ai` | `{prompt, system?, maxTokens?}` | consent once per app; server runs Claude Haiku on the subscription through the `claude` CLI headless (find flags that skip CLAUDE.md/memory/tools/MCP, run in an empty temp cwd, single turn, ≤ 2000 output tokens, 60 s timeout); 20 calls/app/hour; returns `{text}`. Measure input tokens per call and report them (target < 3k). Setting can turn it off |

Injected author client for genui mode only: before the app html, inject a small script defining
`window.paseo` = `{ ready: Promise<HostContext>, context, sendMessage(text), openLink(url),
requestDisplayMode(mode), storage: {get,set,delete,keys}, load(path), download(file), ai(prompt, opts),
onContextChange(cb) }`, implemented on top of the JSON-RPC above (it performs `ui/initialize`).
MCP mode injects nothing (those views bring the ext-apps SDK).

### App identity, CSP and consent

- `appKey` (genui): `<meta name="paseo-app-id" content="slug">` in the app html ([a-z0-9-]{1,40}),
  else the first 16 hex chars of sha256(html). Scoped per agent: storage lives in that agent's
  thread storage. mcp mode: `mcp:<server>:<resourceUri>`.
- genui CSP: `resourceDomains` = CDN allowlist when the setting "Allow CDN libraries" is on
  (default on): `https://cdnjs.cloudflare.com`, `https://unpkg.com`, `https://cdn.jsdelivr.net/npm/`,
  `https://cdn.tailwindcss.com`, `https://code.jquery.com`, `https://fonts.googleapis.com`,
  `https://fonts.gstatic.com`. `connectDomains` = from `<meta name="paseo-connect" content="https://a https://b">`,
  only after the user approves them for that app (approval card above the app: "This app wants to
  connect to: …" [Allow] [Run without network]). Approvals persisted per agent + appKey + exact
  domain set (daemon side, thread storage). mcp mode: the server's `_meta.ui.csp`
  (`connectDomains`, `resourceDomains`; ignore `frameDomains`/`baseUriDomains`), connect domains
  also need the same one-time approval per server.
- Consent for `ui/message`, `ui/open-link`, `paseo/ai`: an inline banner on the app card (not a
  system dialog) showing exactly what will happen: [Allow] [Always for this app] [Cancel].
  "Always" persisted like approvals. Pending requests time out after 2 min (JSON-RPC error).
- Rate limits: `ui/message` 1 per 3 s per app; all requests 50 per 10 s per app (drop beyond).

### Checks for B

- vitest for: request validation, every method's happy path + rejection path (bad params,
  oversize, no consent, rate limit), appKey derivation, CSP assembly, storage caps, path rules
  for paseo/load, filename sanitising for download, the injected `window.paseo` client against
  a fake host. `npx tsc --noEmit` and `npx vitest run` green. Existing 106 tests stay green.
- No change to ```ui behaviour.

---

## C. genui MCP Apps discovery (`server/mcp-apps/`, `shared/mcp-apps-rpc.ts`, `client/mcp-apps/`)

- Sources of MCP servers: OpenCode config `~/.config/opencode/opencode.json` (`mcp` map:
  `{type:"local", command:[...], environment?, enabled?}` / `{type:"remote", url, headers?, enabled?}`)
  plus a project `opencode.json` in the agent's cwd if present. Claude provider agents name MCP
  tools `mcp__<server>__<tool>`; support that naming too. Do NOT run the `opencode` CLI (it resumes
  live sessions, AI-0064). Get OpenCode's MCP tool naming/sanitising rule from its source on
  GitHub (sst/opencode, packages/opencode/src/mcp) and cite the file + commit in a comment.
- Client: `@modelcontextprotocol/sdk` (stdio + streamable HTTP). Connect lazily, tools/list,
  index tools with `_meta.ui.resourceUri` (and legacy `_meta["openai/outputTemplate"]`), keep
  visibility (`_meta.ui.visibility`, default per spec). Fetch the `ui://` resource with
  resources/read (mime `text/html;profile=mcp-app`), keep its `_meta.ui.csp`. Timeouts 30 s,
  idle disconnect 10 min, kill stdio children on plugin unload. Never log headers/env values.
- RPCs (shared/mcp-apps-rpc.ts): `mcpAppsIndexRpc` → list of `{toolNames: string[] (all provider
  spellings), server, tool}`; `mcpAppsResourceRpc {server, tool}` → `{html, csp, resourceUri}`;
  `mcpAppsCallToolRpc {server, name, arguments}` (refuse tools not app-visible, refuse other servers);
  `mcpAppsReadResourceRpc {server, uri}`.
- Client: transformers are synchronous, so load the index at startup and refresh it (every 5 min
  and on demand); a `tool_call` transformer checks the cached index and, on a match, keeps the
  original tool row and adds a plugin item (kind `genui-mcp-app`, version 1) with
  `{server, tool, callId, input, output, status}`; check `PluginTimelineTransformResult` /
  `PluginTimelineItem` in packages/plugin for how to keep the original item. The renderer fetches
  the resource and renders B's `AppFrame` in `mcp` mode (tool result built as a CallToolResult from
  the item: text content from the output; structuredContent if the item metadata carries it; say
  in a comment what OpenCode keeps).
- Tests: a fixture stdio MCP server in `test/fixtures/` (SDK based) declaring one UI tool and one
  app-only tool; tests for config parsing (both shapes, disabled servers, project override), name
  mapping both providers, index, resource read, call-tool visibility refusal, transformer match.
- Coordinate with B only through the AppFrame props in this spec. If B hasn't landed when you get
  to the renderer, build against the documented props and leave the import behind a small adapter.

## D. Docs, instructions, settings (after B)

- `shared/instructions.ts` ```app section: the page environment (inline + CDN allowlist only, no
  network unless `paseo-connect` approved, no storage except `paseo.storage`), `window.paseo` API,
  `paseo-app-id` for apps with state, sizing guidance (design for 320–400 px wide; use media
  queries; no 100vh in inline apps; read `data-paseo-platform`), keep it short (token budget: the
  whole ```app section ≤ 450 words).
- Settings screen: Allow CDN libraries (on), Allow apps to call AI (on, still asks per app),
  Reset app approvals, Run apps automatically on the phone (on; off = tap to run).
- README/OVERVIEW section, a gallery example app using storage + CDN + sendMessage.
