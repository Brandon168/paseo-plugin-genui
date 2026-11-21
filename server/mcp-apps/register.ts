import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  mcpAppsCallToolRpc,
  mcpAppsIndexRpc,
  mcpAppsReadResourceRpc,
  mcpAppsResourceRpc,
} from "../../shared/mcp-apps-rpc";
import { McpAppCalls } from "./calls";
import { McpAppCatalog } from "./catalog";
import { globalOpencodeConfigFiles } from "./config";
import { McpConnections } from "./connections";
import { McpAppResources } from "./resource";

/** How often servers whose idle limit has passed are closed. */
const IDLE_SWEEP_MS = 60_000;

export interface RegisterMcpAppsOptions {
  /** Global OpenCode config files, least specific first. Default: the user's own config. */
  readonly globalFiles?: readonly string[];
  readonly now?: () => number;
}

/**
 * Serves the MCP Apps RPCs and keeps the MCP connections tidy. The returned function ends every
 * connection (stdio children included) and stops the idle sweep; call it when the plugin unloads.
 */
export function registerMcpApps(
  context: PluginServerContext,
  options: RegisterMcpAppsOptions = {},
): () => Promise<void> {
  const connections = new McpConnections({ now: options.now });
  const catalog = new McpAppCatalog(connections, {
    globalFiles: options.globalFiles ?? globalOpencodeConfigFiles(),
    now: options.now,
  });
  const resources = new McpAppResources({ catalog, connections, now: options.now });
  const calls = new McpAppCalls({ catalog, connections });

  context.handle(mcpAppsIndexRpc, async ({ force }) => ({ entries: await catalog.index({ force: force === true }) }));
  context.handle(mcpAppsResourceRpc, ({ server, tool }) => resources.read(server, tool));
  context.handle(mcpAppsCallToolRpc, ({ server, name, arguments: args }) =>
    calls.callTool({ server, name, arguments: args }),
  );
  context.handle(mcpAppsReadResourceRpc, ({ server, uri }) => calls.readResource({ server, uri }));

  // An agent's working directory may hold its own opencode.json; its servers join the catalog.
  context.before("agent.session_open", ({ request }) => {
    if (typeof request.cwd === "string") catalog.noteProjectDir(request.cwd);
  });

  const sweep = setInterval(() => {
    void connections.closeIdle();
  }, IDLE_SWEEP_MS);
  sweep.unref();

  return async () => {
    clearInterval(sweep);
    await connections.closeAll();
  };
}
