# Slice B: host bridge (as built)

Code: `client/app-frame/` (bridge, consent, host context, `window.paseo` client, `AppFrame`),
`server/app-host/` (storage, approvals, download, `paseo/ai`), `shared/app-rpc.ts`, `shared/app-util.ts`.
Spec: [SPEC.md](./SPEC.md) section B.

## AppFrame props (the contract for slice C)

```tsx
import { AppFrame } from "./client/app-frame/AppFrame";

<AppFrame
  mode="mcp"                      // "genui" | "mcp"
  html={resourceHtml}
  agentId={agentId}
  theme={theme}
  platform={layout.platform}      // "ios" | "android" | "web"
  csp={{ connectDomains, resourceDomains }}   // the resource's _meta.ui.csp (frameDomains/baseUriDomains ignored)
  // mcp inputs: flat props or grouped as mcp={{ ... }}
  server="weather"                // MCP server name
  toolName="get_weather"
  toolInput={{ location: "SF" }}
  toolResult={callToolResult}     // CallToolResult; sent as ui/notifications/tool-result when it arrives or changes
  toolCancelled="user stopped"    // sent as ui/notifications/tool-cancelled
  resourceUri="ui://weather/dash" // part of the app key: mcp:<server>:<resourceUri>
  services={{ callTool, readResource }}   // McpAppsServices: slice C wraps mcpAppsCallToolRpc / mcpAppsReadResourceRpc
/>
```

`AppFrame` draws the card contents (frame, consent banner, fullscreen button, connect approval); the
caller supplies the card chrome (see `AppBlockView` in `client/live-ui.tsx`). `services.callTool` and
`readResource` receive `{name, arguments}` / `{uri}`; the server name is C's to add. They may throw:
the message reaches the page as a JSON-RPC error (-32000). Visibility (app-only tools) and same-server
enforcement belong in C's RPCs; the bridge forwards what the page asks.

## Page environment

- genui: the page gets Paseo's CSS variables, base styles and `window.paseo` (see
  `client/app-frame/paseo-client.ts` for the API). `paseo.ai()` resolves the answer text (a string).
- mcp: the page is passed through verbatim; it brings the ext-apps SDK. `hostContext.styles.variables`
  carries the standard MCP variable names.
- Both: `ui/initialize` result has `hostCapabilities` `{openLinks, logging, message: {text}, sandbox.csp, serverTools/serverResources (mcp with services)}`.
  `ui/update-model-context` and `ui/download-file` are not supported (-32601).

## Consent and approvals

- `ui/message`, `ui/open-link`, `paseo/ai`: banner on the card with the exact text, URL or prompt:
  Allow / Always for this app / Cancel. 2 min timeout, 3 waiting at most. AI "Allow" holds for the rest
  of the mounted app.
- Network: `paseo-connect` meta (genui) or `_meta.ui.csp.connectDomains` (mcp) are held back until the
  user approves that exact domain set; the app does not start before the decision (Allow / Run without network).
  mcp approvals are per server.
- Persisted on the daemon in `<thread storage>/apps/<id>.approvals.json`. "Always" is bound to the
  exact HTML (first 16 hex of sha256), so an edited app asks again.
- Settings: `allowCdnLibraries`, `allowAppAi`, `autoRunAppsOnPhone` (Generative UI settings), "Reset app approvals" button.
- Phones: `startsWithoutTap` (policy.ts). On iOS and Android with `autoRunAppsOnPhone` off, an inline app waits behind a "Run app" card until tapped; desktop and web always start apps.

## Measured: `paseo/ai`

`claude -p --model haiku --safe-mode --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}'
--disable-slash-commands --no-session-persistence --system-prompt <short> --output-format json`, stdin
prompt, empty temp cwd, minimal env (claude 2.1.327). One real call: 2 input + 658 cache-creation = 660
input tokens, 11 output tokens, 0.9 s, subscription login worked (`--bare` would not).
