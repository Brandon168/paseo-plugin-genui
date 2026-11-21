import type { PluginClientContext } from "@getpaseo/plugin/client";
import {
  MCP_APP_ITEM_KIND,
  MCP_APP_ITEM_VERSION,
  mcpAppItemDataSchema,
  mcpAppsIndexRpc,
} from "../../shared/mcp-apps-rpc";
import { createMcpAppIndexStore } from "./index-store";
import { McpAppTimelineItem } from "./renderer";
import { mcpAppTransform } from "./transform";

/**
 * Registers MCP Apps tool views: the cached UI tool index, the `tool_call` transform that turns
 * an app tool's row into a plugin item, and the renderer for that item. Returns the cleanup.
 */
export function registerMcpApps(client: PluginClientContext): () => void {
  let disposed = false;
  let removeTransformer: () => void = () => undefined;

  const addTransformer = (): void => {
    removeTransformer = client.addTimelineTransformer({
      id: "genui-mcp-app",
      query: { itemType: "tool_call" },
      transform: mcpAppTransform((providerName) => store.lookup(providerName)),
    });
  };

  // Paseo caches each row's transform result per transformer set. The index loads asynchronously,
  // so rows shown first (a page load, a reconnect) were transformed against an empty index and
  // stayed plain tool rows. Registering the transformer again after the index changes makes
  // Paseo transform every row again.
  const store = createMcpAppIndexStore({
    load: async () => (await client.rpc(mcpAppsIndexRpc, {})).entries,
    onChange: () => {
      if (disposed) return;
      removeTransformer();
      addTransformer();
    },
  });

  addTransformer();
  void store.refresh();
  const removeRenderer = client.addTimelineRenderer({
    kind: MCP_APP_ITEM_KIND,
    version: MCP_APP_ITEM_VERSION,
    schema: mcpAppItemDataSchema,
    Component: McpAppTimelineItem,
  });

  return () => {
    disposed = true;
    store.dispose();
    removeTransformer();
    removeRenderer();
  };
}
