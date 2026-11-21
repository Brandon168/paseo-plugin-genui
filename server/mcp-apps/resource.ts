import {
  MAX_MCP_APP_CSP_DOMAINS,
  MCP_APP_MIME_TYPE,
  type McpAppCsp,
  type McpAppResourceResult,
} from "../../shared/mcp-apps-rpc";
import type { McpAppCatalog } from "./catalog";
import type { McpConnections, McpReadResult } from "./connections";

/** Largest app document accepted (text, or the decoded base64 blob). */
export const MAX_MCP_APP_HTML_BYTES = 2 * 1024 * 1024;
const MAX_CSP_DOMAIN_CHARS = 300;
const RESOURCE_CACHE_MS = 5 * 60_000;
const RESOURCE_CACHE_ENTRIES = 32;

export interface McpAppResourceDeps {
  readonly catalog: Pick<McpAppCatalog, "findTool">;
  readonly connections: Pick<McpConnections, "readResource">;
  readonly now?: () => number;
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const failure = (error: string): McpAppResourceResult => ({ ok: false, error });

/**
 * Keeps the CSP domains a view may use: connect and resource origins only. The server's
 * `frameDomains` and `baseUriDomains` are ignored (the spec's host rules forbid them here).
 * Domain validation (scheme, wildcard, path) is done again by the frame that loads the app.
 */
export function sanitizeAppCsp(meta: unknown): McpAppCsp {
  const csp = isRecord(meta) && isRecord(meta.ui) && isRecord(meta.ui.csp) ? meta.ui.csp : {};
  return { connectDomains: domainList(csp.connectDomains), resourceDomains: domainList(csp.resourceDomains) };
}

function domainList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const domains = new Set<string>();
  for (const item of value) {
    if (domains.size >= MAX_MCP_APP_CSP_DOMAINS) break;
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed !== "" && trimmed.length <= MAX_CSP_DOMAIN_CHARS) domains.add(trimmed);
  }
  return [...domains];
}

function normalizeMime(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, "") : "";
}

/** The app document of a `resources/read` result, or the reason it is not one. */
export function appDocumentOf(
  result: McpReadResult,
  uri: string,
): { ok: true; html: string; csp: McpAppCsp } | { ok: false; error: string } {
  const item = result.contents.find((content) => content.uri === uri) as JsonRecord | undefined;
  if (!item) return { ok: false, error: "the server did not return the app's resource" };
  if (normalizeMime(item.mimeType) !== MCP_APP_MIME_TYPE) {
    return { ok: false, error: "the resource is not an MCP app document" };
  }
  let html: string;
  if (typeof item.text === "string") {
    if (Buffer.byteLength(item.text, "utf8") > MAX_MCP_APP_HTML_BYTES) {
      return { ok: false, error: "the app document is too large" };
    }
    html = item.text;
  } else if (typeof item.blob === "string") {
    // Base64 expands by 4/3, so the encoded length is checked before decoding.
    if (item.blob.length > Math.ceil((MAX_MCP_APP_HTML_BYTES * 4) / 3) + 4) {
      return { ok: false, error: "the app document is too large" };
    }
    html = Buffer.from(item.blob, "base64").toString("utf8");
    if (Buffer.byteLength(html, "utf8") > MAX_MCP_APP_HTML_BYTES) {
      return { ok: false, error: "the app document is too large" };
    }
  } else {
    return { ok: false, error: "the app document is empty" };
  }
  return { ok: true, html, csp: sanitizeAppCsp(item._meta) };
}

/**
 * The `ui://` document of an app tool. Reads are cached for a few minutes, so a timeline that
 * re-renders a tool row does not ask the server again.
 */
export class McpAppResources {
  private readonly deps: McpAppResourceDeps;
  private readonly now: () => number;
  private readonly cache = new Map<string, { readonly at: number; readonly value: McpAppResourceResult }>();

  constructor(deps: McpAppResourceDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  async read(server: string, tool: string): Promise<McpAppResourceResult> {
    const found = await this.deps.catalog.findTool(server, tool);
    if (!found) return failure("no such tool on this server");
    if (!found.meta) return failure("this tool does not declare an MCP app");

    const uri = found.meta.resourceUri;
    const key = `${server}\u0000${uri}`;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && now - cached.at < RESOURCE_CACHE_MS) return cached.value;

    let result: McpReadResult;
    try {
      result = await this.deps.connections.readResource(found.spec, uri, { touch: true });
    } catch {
      return failure("the server did not return the app");
    }
    const document = appDocumentOf(result, uri);
    const value: McpAppResourceResult = document.ok
      ? { ok: true, html: document.html, csp: document.csp, resourceUri: uri }
      : failure(document.error);
    if (value.ok) this.remember(key, now, value);
    return value;
  }

  private remember(key: string, at: number, value: McpAppResourceResult): void {
    this.cache.delete(key);
    this.cache.set(key, { at, value });
    if (this.cache.size > RESOURCE_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
  }
}
