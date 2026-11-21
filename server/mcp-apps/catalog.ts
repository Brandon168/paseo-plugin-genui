import path from "node:path";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MAX_MCP_APP_INDEX_ENTRIES, type McpAppIndexEntry } from "../../shared/mcp-apps-rpc";
import {
  loadMcpServers,
  projectOpencodeConfigFiles,
  type McpServerSpec,
} from "./config";
import { transportFingerprint, type McpConnections } from "./connections";
import { providerToolNames } from "./naming";

/** How long a server's tool list is trusted while its connection is open. */
export const MCP_TOOL_LIST_TTL_MS = 5 * 60_000;
/** How long a failed listing waits before the server is tried again. */
export const MCP_LISTING_RETRY_MS = 5 * 60_000;
/** How often the config files are read again. */
const SPEC_RELOAD_MS = 30_000;
const MAX_PROJECT_DIRS = 20;
const MAX_URI_CHARS = 2048;

export interface AppToolMeta {
  readonly resourceUri: string;
  /** The tool may be called from its app (`tools/call` from the view). */
  readonly appVisible: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function uiUri(value: unknown): string | null {
  const ok =
    typeof value === "string" && value.startsWith("ui://") && value.length > "ui://".length && value.length <= MAX_URI_CHARS;
  return ok ? value : null;
}

/**
 * The UI declaration of an MCP tool. Spec order: `_meta.ui` (resourceUri, visibility: default
 * ["model", "app"] when omitted), then the flat `_meta["ui/resourceUri"]` (deprecated, same
 * defaults), then the OpenAI Apps SDK key `_meta["openai/outputTemplate"]`. The OpenAI key only
 * marks the tool for rendering: its tool is not app-callable here. Tools without a UI key are
 * not app-callable either, even though the spec's default would allow it.
 */
export function readAppToolMeta(tool: Pick<Tool, "_meta">): AppToolMeta | null {
  const meta = tool._meta;
  if (!isRecord(meta)) return null;

  const ui = isRecord(meta.ui) ? meta.ui : undefined;
  const declared = uiUri(ui?.resourceUri);
  if (ui && declared) {
    const visibility = ui.visibility === undefined ? ["model", "app"] : ui.visibility;
    const appVisible = Array.isArray(visibility) && visibility.includes("app");
    return { resourceUri: declared, appVisible };
  }

  const flat = uiUri(meta["ui/resourceUri"]);
  if (flat) return { resourceUri: flat, appVisible: true };

  const openai = uiUri(meta["openai/outputTemplate"]);
  if (openai) return { resourceUri: openai, appVisible: false };

  return null;
}

/** The part of the connection layer the catalog uses; tests can supply a fake. */
export type CatalogConnections = Pick<McpConnections, "isOpen" | "listTools" | "close">;

export interface McpAppCatalogOptions {
  /** Global OpenCode config files, least specific first. */
  readonly globalFiles: readonly string[];
  readonly now?: () => number;
  readonly listTtlMs?: number;
  readonly retryMs?: number;
  readonly reloadMs?: number;
}

interface Listing {
  readonly fingerprint: string;
  tools: Tool[] | null;
  listedAt: number;
  failedAt: number | null;
}

export interface FoundTool {
  readonly spec: McpServerSpec;
  readonly tool: Tool;
  readonly meta: AppToolMeta | null;
}

/**
 * The MCP servers OpenCode knows about, their tool lists, and the index of UI tools.
 *
 * A server's tool list is fetched the first time it is needed. Later, only a server whose
 * connection is open is listed again (once its list is older than the TTL): a server that was
 * idle-closed keeps its cached list, so the index never restarts idle servers. A failed listing
 * waits MCP_LISTING_RETRY_MS before it is tried again.
 */
export class McpAppCatalog {
  private readonly connections: CatalogConnections;
  private readonly globalFiles: readonly string[];
  private readonly now: () => number;
  private readonly listTtlMs: number;
  private readonly retryMs: number;
  private readonly reloadMs: number;
  private readonly projectDirs: string[] = [];
  private readonly listings = new Map<string, Listing>();
  private specs = new Map<string, McpServerSpec>();
  private specsLoadedAt = Number.NEGATIVE_INFINITY;
  private specsDirty = true;

  constructor(connections: CatalogConnections, options: McpAppCatalogOptions) {
    this.connections = connections;
    this.globalFiles = options.globalFiles;
    this.now = options.now ?? Date.now;
    this.listTtlMs = options.listTtlMs ?? MCP_TOOL_LIST_TTL_MS;
    this.retryMs = options.retryMs ?? MCP_LISTING_RETRY_MS;
    this.reloadMs = options.reloadMs ?? SPEC_RELOAD_MS;
  }

  /** An agent's working directory: its opencode.json adds or overrides servers from now on. */
  noteProjectDir(dir: string): void {
    if (!path.isAbsolute(dir)) return;
    const existing = this.projectDirs.indexOf(dir);
    if (existing !== -1) this.projectDirs.splice(existing, 1);
    this.projectDirs.push(dir);
    if (this.projectDirs.length > MAX_PROJECT_DIRS) this.projectDirs.shift();
    this.specsDirty = true;
  }

  /** The UI tools of every configured server, as the chat matches them. */
  async index(options: { force?: boolean } = {}): Promise<McpAppIndexEntry[]> {
    await this.reloadSpecs();
    await Promise.all([...this.specs.values()].map((spec) => this.refreshListing(spec, options.force === true)));
    return this.entries();
  }

  /** A configured server by name, or null. Config files are read again when they are due. */
  async server(name: string): Promise<McpServerSpec | null> {
    await this.reloadSpecs();
    return this.specs.get(name) ?? null;
  }

  /** A tool of one configured server, listing the server first when needed. */
  async findTool(serverName: string, toolName: string): Promise<FoundTool | null> {
    await this.reloadSpecs();
    const spec = this.specs.get(serverName);
    if (!spec) return null;
    await this.refreshListing(spec, false);
    const tool = this.listings.get(serverName)?.tools?.find((candidate) => candidate.name === toolName);
    if (!tool) return null;
    return { spec, tool, meta: readAppToolMeta(tool) };
  }

  private async reloadSpecs(): Promise<void> {
    const now = this.now();
    if (!this.specsDirty && now - this.specsLoadedAt < this.reloadMs) return;
    this.specsDirty = false;
    const files = [...this.globalFiles, ...this.projectDirs.flatMap(projectOpencodeConfigFiles)];
    const loaded = await loadMcpServers(files);
    this.specsLoadedAt = now;

    const next = new Map(loaded.servers.map((spec) => [spec.name, spec]));
    for (const name of this.specs.keys()) {
      if (next.has(name)) continue;
      this.listings.delete(name);
      await this.connections.close(name);
    }
    this.specs = next;
  }

  private listingFor(spec: McpServerSpec): Listing {
    const fingerprint = transportFingerprint(spec);
    const current = this.listings.get(spec.name);
    if (current && current.fingerprint === fingerprint) return current;
    const fresh: Listing = { fingerprint, tools: null, listedAt: 0, failedAt: null };
    this.listings.set(spec.name, fresh);
    return fresh;
  }

  private async refreshListing(spec: McpServerSpec, force: boolean): Promise<void> {
    const now = this.now();
    const listing = this.listingFor(spec);
    if (listing.failedAt !== null && now - listing.failedAt < this.retryMs) return;

    const never = listing.tools === null;
    const stale =
      listing.tools !== null && this.connections.isOpen(spec.name) && now - listing.listedAt >= this.listTtlMs;
    if (!never && !stale && !force) return;

    try {
      listing.tools = await this.connections.listTools(spec, { touch: false });
      listing.listedAt = now;
      listing.failedAt = null;
    } catch {
      // Only the time matters here: the failure waits MCP_LISTING_RETRY_MS before a retry.
      listing.failedAt = now;
    }
  }

  private entries(): McpAppIndexEntry[] {
    const claimed = new Set<string>();
    const entries: McpAppIndexEntry[] = [];
    const specs = [...this.specs.values()].sort((left, right) => left.name.localeCompare(right.name));
    for (const spec of specs) {
      for (const tool of this.listings.get(spec.name)?.tools ?? []) {
        if (readAppToolMeta(tool) === null) continue;
        const toolNames = providerToolNames(spec.name, tool.name);
        // Two tools that the providers spell alike are ambiguous: neither is matched.
        if (toolNames.some((name) => claimed.has(name))) continue;
        for (const name of toolNames) claimed.add(name);
        entries.push({ toolNames, server: spec.name, tool: tool.name });
        if (entries.length >= MAX_MCP_APP_INDEX_ENTRIES) return entries;
      }
    }
    return entries;
  }
}
