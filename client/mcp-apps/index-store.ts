import type { McpAppIndexEntry } from "../../shared/mcp-apps-rpc";

/** How often the client asks the daemon for the UI tool index. */
export const MCP_APP_INDEX_REFRESH_MS = 5 * 60_000;
/** How long a failed load waits before it is tried again (the daemon may still be connecting). */
export const MCP_APP_INDEX_RETRY_MS = 30_000;

export interface AppToolLookup {
  readonly server: string;
  readonly tool: string;
}

export interface McpAppIndexStore {
  /** The MCP tool behind a provider's tool name, from the last successful load. */
  lookup(providerName: string): AppToolLookup | undefined;
  /** Loads the index now and keeps refreshing it. A failed load keeps the previous index. */
  refresh(): Promise<void>;
  dispose(): void;
}

export interface McpAppIndexStoreOptions {
  readonly load: () => Promise<readonly McpAppIndexEntry[]>;
  readonly refreshMs?: number;
  readonly retryMs?: number;
}

/** Maps every provider spelling to its tool. A spelling claimed twice keeps the first entry. */
export function indexLookups(entries: readonly McpAppIndexEntry[]): Map<string, AppToolLookup> {
  const lookups = new Map<string, AppToolLookup>();
  for (const entry of entries) {
    for (const name of entry.toolNames) {
      if (!lookups.has(name)) lookups.set(name, { server: entry.server, tool: entry.tool });
    }
  }
  return lookups;
}

/**
 * The timeline transformers are synchronous, so they read this cached index. It is loaded when
 * the plugin starts and refreshed on a timer.
 */
export function createMcpAppIndexStore(options: McpAppIndexStoreOptions): McpAppIndexStore {
  const refreshMs = options.refreshMs ?? MCP_APP_INDEX_REFRESH_MS;
  const retryMs = options.retryMs ?? MCP_APP_INDEX_RETRY_MS;
  let lookups = new Map<string, AppToolLookup>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const schedule = (ms: number): void => {
    if (disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void refresh();
    }, ms);
  };

  const refresh = async (): Promise<void> => {
    if (disposed) return;
    try {
      const entries = await options.load();
      if (disposed) return;
      lookups = indexLookups(entries);
      schedule(refreshMs);
    } catch {
      schedule(retryMs);
    }
  };

  return {
    lookup: (providerName) => lookups.get(providerName),
    refresh,
    dispose: () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
