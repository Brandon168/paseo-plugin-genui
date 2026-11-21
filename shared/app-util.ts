// Pure helpers for inline apps, shared by the client bridge and the daemon handlers.
// Everything here treats its input as hostile: the HTML and every value a page sends are
// written by an LLM agent that also reads untrusted content, or by a third-party MCP server.

export const APP_LIMITS = {
  /** Serialized JSON per app. */
  storageBytes: 1024 * 1024,
  keyChars: 200,
  /** `ui/message` text. */
  messageChars: 8000,
  downloadBytes: 10 * 1024 * 1024,
  /** Text up to this size also opens the share sheet on native. */
  shareTextBytes: 100 * 1024,
  pathChars: 1024,
  urlChars: 2048,
  aiPromptChars: 16_000,
  aiSystemChars: 4000,
  aiMaxTokens: 2000,
  aiTimeoutMs: 60_000,
  aiCallsPerHour: 20,
  /** JSON per message, each way (HtmlFrame's cap). */
  frameMessageBytes: 4 * 1024 * 1024,
  consentTimeoutMs: 120_000,
  maxPendingConsents: 3,
  minHeight: 80,
  maxHeight: 1400,
  logChars: 2000,
} as const;

/** CDN hosts allowed for scripts, styles, images, fonts and media when "Allow CDN libraries" is on. */
export const CDN_ALLOWLIST: readonly string[] = [
  "https://cdnjs.cloudflare.com",
  "https://unpkg.com",
  "https://cdn.jsdelivr.net/npm/",
  "https://cdn.tailwindcss.com",
  "https://code.jquery.com",
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
];

// --- Origins -------------------------------------------------------------------------------

const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const ORIGIN_PATTERN = new RegExp(
  `^(https|wss)://((?:\\*\\.)?(?:${HOST_LABEL}\\.)+${HOST_LABEL})(?::([0-9]{1,5}))?(/[A-Za-z0-9._~%/-]*)?$`,
  "i",
);

export type OriginScheme = "https" | "wss";

/**
 * Validates one CSP source for an app: `https://host[:port][/path/]` (or `wss://` for connect),
 * with an optional leading `*.` on the host. Returns the lowercased form, or null. Rejects bare
 * `*`, scheme-only sources, quotes, semicolons, spaces, IP literals, single-label hosts, `*.tld`,
 * and a path that does not end in `/`.
 */
export function validateAppOrigin(entry: unknown, schemes: readonly OriginScheme[]): string | null {
  if (typeof entry !== "string" || entry.length === 0 || entry.length > 253) return null;
  const match = ORIGIN_PATTERN.exec(entry);
  if (match === null) return null;
  const [, rawScheme, rawHost, port, path] = match;
  if (rawScheme === undefined || rawHost === undefined) return null;
  const scheme = rawScheme.toLowerCase();
  const host = rawHost.toLowerCase();
  if (!schemes.includes(scheme as OriginScheme)) return null;
  const bare = host.startsWith("*.") ? host.slice(2) : host;
  const labels = bare.split(".");
  if (labels.length < 2) return null;
  if (/^[0-9.]+$/.test(bare)) return null;
  const tld = labels[labels.length - 1] ?? "";
  if (/^[0-9]+$/.test(tld)) return null;
  if (port !== undefined) {
    const value = Number(port);
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
  }
  if (path !== undefined && !path.endsWith("/")) return null;
  if (path !== undefined && path.includes("//")) return null;
  if (path !== undefined && /(^|\/)\.\.?(\/|$)/.test(path)) return null;
  return `${scheme}://${host}${port !== undefined ? `:${port}` : ""}${path ?? ""}`;
}

export interface ValidatedDomains {
  readonly valid: readonly string[];
  readonly rejected: readonly string[];
}

export function validateAppDomains(
  entries: readonly unknown[] | undefined,
  schemes: readonly OriginScheme[],
  max = 20,
): ValidatedDomains {
  const valid: string[] = [];
  const rejected: string[] = [];
  for (const entry of (entries ?? []).slice(0, max * 2)) {
    const ok = validateAppOrigin(entry, schemes);
    if (ok === null) rejected.push(typeof entry === "string" ? entry.slice(0, 80) : String(entry).slice(0, 80));
    else if (!valid.includes(ok) && valid.length < max) valid.push(ok);
  }
  return { valid, rejected };
}

/** Stable key for "this exact set of domains": sorted, unique, space separated. */
export function connectKey(domains: readonly string[]): string {
  return [...new Set(domains)].sort().join(" ");
}

export interface AppCsp {
  readonly resourceDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
}

/**
 * The CSP string for the stock-web fallback frame (Paseo's HtmlFrame builds its own from the same
 * inputs). Domains are re-validated here; anything invalid is dropped.
 */
export function buildAppCsp(csp: AppCsp | undefined): string {
  const resources = validateAppDomains(csp?.resourceDomains, ["https"]).valid;
  const connect = validateAppDomains(csp?.connectDomains, ["https", "wss"]).valid;
  const list = (extra: string) => [extra, ...resources].filter((part) => part !== "").join(" ");
  return [
    "default-src 'none'",
    `script-src ${list("'unsafe-inline' 'unsafe-eval'")}`,
    `style-src ${list("'unsafe-inline'")}`,
    `img-src ${list("data: blob:")}`,
    `font-src ${list("data:")}`,
    `media-src ${list("data: blob:")}`,
    `connect-src ${connect.length > 0 ? connect.join(" ") : "'none'"}`,
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'",
    "object-src 'none'",
  ].join("; ");
}

// --- URLs ----------------------------------------------------------------------------------

/**
 * `ui/open-link` accepts https only: ASCII host (punycode, so what the user sees is what opens),
 * no credentials, no whitespace or control characters. Returns the URL to show and open, or null.
 */
export function validateOpenLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > APP_LIMITS.urlChars) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000- \u007f-\u009f\\]/.test(value) || /[^\x21-\x7e]/.test(value)) return null;
  const match = /^https:\/\/([^/?#]+)([/?#].*)?$/i.exec(value);
  if (match === null) return null;
  const authority = match[1] ?? "";
  if (authority.includes("@")) return null;
  const hostMatch = /^([a-z0-9]([a-z0-9.-]*[a-z0-9])?)(:([0-9]{1,5}))?$/i.exec(authority);
  if (hostMatch === null) return null;
  const host = hostMatch[1] ?? "";
  if (host.includes("..")) return null;
  const port = hostMatch[4];
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return null;
  return `https://${authority.toLowerCase()}${match[2] ?? ""}`;
}

// --- App identity --------------------------------------------------------------------------

const APP_SLUG = /^[a-z0-9-]{1,40}$/;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function utf8Bytes(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    let code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        index++;
      }
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return out;
}

/** Synchronous SHA-256 (hex): Hermes has no sync crypto, and the key is needed during render. */
export function sha256Hex(text: string): string {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  bytes.push((high >>> 24) & 255, (high >>> 16) & 255, (high >>> 8) & 255, high & 255);
  bytes.push((low >>> 24) & 255, (low >>> 16) & 255, (low >>> 8) & 255, low & 255);

  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array<number>(64).fill(0);
  const rotr = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const at = offset + t * 4;
      w[t] = ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15]!, 7) ^ rotr(w[t - 15]!, 18) ^ (w[t - 15]! >>> 3);
      const s1 = rotr(w[t - 2]!, 17) ^ rotr(w[t - 2]!, 19) ^ (w[t - 2]! >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
    h[5] = (h[5]! + f) >>> 0;
    h[6] = (h[6]! + g) >>> 0;
    h[7] = (h[7]! + hh) >>> 0;
  }
  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

/** First 16 hex chars of sha256(html): the fallback app id and the "this exact HTML" fingerprint. */
export function htmlFingerprint(html: string): string {
  return sha256Hex(html).slice(0, 16);
}

/** Reads `<meta name="..." content="...">` tags; later duplicates are ignored. */
export function readMetaTag(html: string, name: string): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags.slice(0, 200)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag.matchAll(/([a-zA-Z_:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
      const key = attribute[1]?.toLowerCase();
      if (key !== undefined && !attributes.has(key)) attributes.set(key, attribute[2] ?? attribute[3] ?? attribute[4] ?? "");
    }
    if (attributes.get("name")?.toLowerCase() === name) return attributes.get("content") ?? "";
  }
  return null;
}

/** `<meta name="paseo-app-id" content="slug">` ([a-z0-9-]{1,40}), else the HTML fingerprint. */
export function deriveAppKey(html: string): string {
  const declared = readMetaTag(html, "paseo-app-id")?.trim();
  if (declared !== undefined && APP_SLUG.test(declared)) return declared;
  return htmlFingerprint(html);
}

/** The https/wss origins in `<meta name="paseo-connect" content="https://a https://b">`. */
export function readConnectRequest(html: string): ValidatedDomains {
  const content = readMetaTag(html, "paseo-connect");
  if (content === null) return { valid: [], rejected: [] };
  return validateAppDomains(content.split(/\s+/).filter((part) => part !== ""), ["https", "wss"]);
}

export function mcpAppKey(server: string, resourceUri: string): string {
  return `mcp:${server}:${resourceUri}`;
}

/** A file name for an app's data on the daemon: the slug itself, or a hash for anything else. */
export function appFileId(appKey: string): string {
  return APP_SLUG.test(appKey) ? appKey : `x-${sha256Hex(appKey).slice(0, 24)}`;
}

// --- Downloads -----------------------------------------------------------------------------

/** A file name that is safe to create anywhere: no path parts, no control characters, no leading dots. */
export function sanitizeFilename(name: unknown): string {
  let value = typeof name === "string" ? name : "";
  // eslint-disable-next-line no-control-regex
  value = value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
  value = value.split(/[\\/]/).pop() ?? "";
  value = value.replace(/[<>:"|?*‪-‮⁦-⁩]/g, "_");
  value = value.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(value)) value = `_${value}`;
  if (value.length > 100) {
    const dot = value.lastIndexOf(".");
    const ext = dot > 0 && value.length - dot <= 10 ? value.slice(dot) : "";
    value = value.slice(0, 100 - ext.length) + ext;
  }
  return value === "" ? "download" : value;
}

export function isValidMimeType(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(value);
}

export function base64DecodedLength(value: string): number | null {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      index++;
    } else bytes += 3;
  }
  return bytes;
}

// --- Paths ---------------------------------------------------------------------------------

/**
 * Whether `paseo/load` must refuse `requested`: the app data directory of the thread storage holds
 * every app's saved state and approvals, so one page must not read another's. Names are matched
 * lexically on every spelling that resolves into `<storage>/apps/`.
 */
export function isProtectedStoragePath(requested: string, storageDir: string): boolean {
  const prefixes = ["$BB_THREAD_STORAGE/", "$PASEO_THREAD_STORAGE/"];
  let relative: string | null = null;
  for (const prefix of prefixes) {
    if (requested.startsWith(prefix)) relative = requested.slice(prefix.length);
  }
  if (relative === null) {
    const normalizedDir = normalizeSlashes(storageDir);
    const normalized = normalizeSlashes(requested);
    if (normalized.startsWith("/")) {
      if (normalized === normalizedDir || !normalized.startsWith(`${normalizedDir}/`)) return false;
      relative = normalized.slice(normalizedDir.length + 1);
    } else {
      relative = requested;
    }
  }
  const first = normalizeRelative(relative).split("/")[0] ?? "";
  return first.toLowerCase() === "apps";
}

function normalizeSlashes(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return `${value.startsWith("/") ? "/" : ""}${parts.join("/")}`;
}

function normalizeRelative(value: string): string {
  const parts: string[] = [];
  for (const part of value.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

/** Paths from a page: non-empty, within the cap, no NUL or other control characters. */
export function isAcceptablePath(value: unknown): value is string {
  // eslint-disable-next-line no-control-regex
  return typeof value === "string" && value.length > 0 && value.length <= APP_LIMITS.pathChars && !/[\u0000-\u001f\u007f]/.test(value);
}
