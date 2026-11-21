import { Platform } from "react-native";

interface WebStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface WebIframeElement {
  title: string;
  srcdoc: string;
  referrerPolicy: string;
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string): void } | null;
  readonly style: {
    width: string;
    height: string;
    border: string;
    display: string;
    borderRadius: string;
    backgroundColor: string;
  };
  setAttribute(name: string, value: string): void;
  remove(): void;
}

interface WebContainerElement {
  innerHTML: string;
  appendChild(child: WebIframeElement): void;
}

interface WebMessageEvent {
  readonly source: unknown;
  readonly data: unknown;
}

interface WebGlobal {
  readonly localStorage?: WebStorage;
  readonly document?: {
    createElement(tag: "iframe"): WebIframeElement;
  };
  readonly window?: {
    addEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: WebMessageEvent) => void): void;
    readonly location?: { readonly pathname: string };
    readonly history?: { pushState(state: null, unused: string, url: string): void };
    dispatchEvent?(event: unknown): boolean;
  };
  readonly PopStateEvent?: new (type: "popstate") => unknown;
}

const memoryStore = new Map<string, string>();

function getWeb(): WebGlobal | null {
  if (Platform.OS !== "web") return null;
  return globalThis as unknown as WebGlobal;
}

export function readStorage(key: string): string | null {
  const web = getWeb();
  if (web?.localStorage) {
    try {
      return web.localStorage.getItem(key);
    } catch {
      // Fall back to memory store
    }
  }
  return memoryStore.get(key) ?? null;
}

export function writeStorage(key: string, value: string): void {
  memoryStore.set(key, value);
  const web = getWeb();
  if (web?.localStorage) {
    try {
      web.localStorage.setItem(key, value);
    } catch {
      // Ignore quota errors
    }
  }
}

export function canRenderWebIframe(): boolean {
  const web = getWeb();
  return Platform.OS === "web" && Boolean(web?.document && web?.window);
}

const BOOTSTRAP = `(function(){
var host=window.parent,last=-1;
document.documentElement.dataset.paseoPlatform="web";
function post(m){m.source="genui-app";host.postMessage(m,"*");}
function measure(){
var b=document.body,h=Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height,b?b.scrollHeight:0));
if(h!==last){last=h;post({type:"height",height:h});}
}
var ro=new ResizeObserver(measure);
ro.observe(document.documentElement);
document.addEventListener("DOMContentLoaded",function(){if(document.body)ro.observe(document.body);measure();});
addEventListener("load",measure);
addEventListener("error",function(e){post({type:"error",message:String(e.message||"Script error")});});
})();`;

/** Same document layout Paseo's HtmlFrame builds: doctype, then the CSP, then viewport, base style, bootstrap, the page. */
function buildSrcdoc(html: string, csp: string): string {
  const doctype = "<!doctype html>";
  const metaCsp = '<meta http-equiv="Content-Security-Policy" content="' + csp.replace(/"/g, "&quot;") + '">';
  const metaVp = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
  const styleBase = "<style>html{-webkit-text-size-adjust:100%}</style>";
  const scriptBoot = "<script>" + BOOTSTRAP + "</script>";
  return [doctype, metaCsp, metaVp, styleBase, scriptBoot, html].join("\n");
}

export interface SandboxedIframe {
  /** Delivers a JSON value to the page as a message event (source is the parent window). */
  post(message: unknown): void;
  dispose(): void;
}

const MAX_FRAME_MESSAGE_BYTES = 4 * 1024 * 1024;

/**
 * Stock-Paseo web path: a `sandbox="allow-scripts"` srcdoc iframe (opaque origin, no popups, forms,
 * downloads or top navigation). Used only when the host has no `HtmlFrame`.
 */
export function mountSandboxedAppIframe(
  hostRef: unknown,
  options: {
    html: string;
    /** The full Content-Security-Policy string. */
    csp: string;
    height: number;
    fill?: boolean;
    onHeight(height: number): void;
    onMessage?(message: unknown): void;
    onError(message: string): void;
  },
): SandboxedIframe {
  const none: SandboxedIframe = { post() {}, dispose() {} };
  const web = getWeb();
  if (!web?.document || !web.window || !hostRef || typeof hostRef !== "object") return none;
  const container = hostRef as WebContainerElement;
  if (typeof container.appendChild !== "function") return none;

  const iframe = web.document.createElement("iframe");
  iframe.title = "Interactive App";
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.referrerPolicy = "no-referrer";
  iframe.style.width = "100%";
  iframe.style.height = options.fill ? "100%" : `${options.height}px`;
  iframe.style.border = "0";
  iframe.style.display = "block";
  iframe.style.borderRadius = options.fill ? "0" : "8px";
  iframe.style.backgroundColor = "transparent";
  iframe.srcdoc = buildSrcdoc(options.html, options.csp);

  container.innerHTML = "";
  container.appendChild(iframe);

  const onMessage = (event: WebMessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const internal = data as Record<string, unknown>;
      if (internal.source === "genui-app") {
        if (internal.type === "height" && typeof internal.height === "number" && Number.isFinite(internal.height)) {
          const clamped = Math.min(1400, Math.max(80, Math.ceil(internal.height)));
          if (!options.fill) iframe.style.height = `${clamped}px`;
          options.onHeight(clamped);
        } else if (internal.type === "error" && typeof internal.message === "string") {
          options.onError(internal.message.slice(0, 500));
        }
        return;
      }
    }
    try {
      if ((JSON.stringify(data)?.length ?? 0) > MAX_FRAME_MESSAGE_BYTES) {
        options.onError("A message from the app was over 4 MB and was dropped.");
        return;
      }
    } catch {
      return;
    }
    options.onMessage?.(data);
  };

  web.window.addEventListener("message", onMessage);
  return {
    post(message) {
      try {
        if ((JSON.stringify(message)?.length ?? 0) > MAX_FRAME_MESSAGE_BYTES) return;
      } catch {
        return;
      }
      iframe.contentWindow?.postMessage(message, "*");
    },
    dispose() {
      web.window?.removeEventListener("message", onMessage);
      iframe.remove();
    },
  };
}

/**
 * Opens an absolute file path in a file tab of the workspace on screen, the way the
 * host does for file links in chat. The plugin SDK has no call for it, so this goes
 * through the host's `?open=file:<base64url path>` route. Web and desktop only.
 */
export function openWorkspaceFile(path: string): boolean {
  const web = getWeb();
  const win = web?.window;
  if (!win?.location || !win.history || !win.dispatchEvent || !web?.PopStateEvent) return false;
  if (!path.startsWith("/")) return false;
  const match = /^\/h\/[^/]+\/workspace\/[^/]+/.exec(win.location.pathname);
  if (match === null) return false;
  const token = btoa(unescape(encodeURIComponent(path))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  win.history.pushState(null, "", `${match[0]}?open=${encodeURIComponent(`file:${token}`)}`);
  win.dispatchEvent(new web.PopStateEvent("popstate"));
  return true;
}

interface DownloadAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click(): void;
  remove(): void;
}

interface DownloadGlobal {
  readonly Blob?: new (parts: unknown[], options: { type: string }) => unknown;
  readonly URL?: { createObjectURL(blob: unknown): string; revokeObjectURL(url: string): void };
  readonly document?: { createElement(tag: "a"): DownloadAnchor; readonly body?: { appendChild(child: DownloadAnchor): void } };
  atob?(data: string): string;
}

/** `paseo/download` on web and desktop: a browser download started from the host page, never from the sandboxed frame. */
export function downloadInBrowser(file: {
  filename: string;
  mimeType: string;
  text?: string | undefined;
  base64?: string | undefined;
}): boolean {
  if (Platform.OS !== "web") return false;
  const g = globalThis as unknown as DownloadGlobal;
  if (!g.Blob || !g.URL || !g.document?.body) return false;
  let part: unknown;
  if (file.text !== undefined) {
    part = file.text;
  } else if (file.base64 !== undefined && g.atob) {
    const binary = g.atob(file.base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    part = bytes;
  } else {
    return false;
  }
  const url = g.URL.createObjectURL(new g.Blob([part], { type: file.mimeType }));
  const anchor = g.document.createElement("a");
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  g.document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => g.URL?.revokeObjectURL(url), 10_000);
  return true;
}
