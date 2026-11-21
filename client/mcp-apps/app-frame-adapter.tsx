import type { PluginTheme } from "@getpaseo/plugin";
import { useRpc } from "@getpaseo/plugin/client";
import React, { useMemo } from "react";
import { Platform } from "react-native";
import { mcpAppsCallToolRpc, mcpAppsReadResourceRpc } from "../../shared/mcp-apps-rpc";
import { AppFrame } from "../app-frame/AppFrame";
import type { McpAppsServices } from "../app-frame/bridge";
import type { HostPlatform } from "../app-frame/host-context";
import type { McpToolResult } from "./tool-result";

/** Props the MCP renderer hands to the app frame (spec section B, `mcp` mode). */
export interface McpAppFrameProps {
  readonly html: string;
  readonly mode: "mcp";
  readonly agentId: string;
  /** `mcp:<server>:<resourceUri>` */
  readonly appKey: string;
  readonly csp: { readonly connectDomains: readonly string[]; readonly resourceDomains: readonly string[] };
  readonly theme: PluginTheme;
  readonly mcp: {
    readonly server: string;
    /** The MCP tool name (not the provider spelling). */
    readonly toolName: string;
    readonly toolInput: Readonly<Record<string, unknown>> | null;
    /** Undefined while the tool runs. */
    readonly toolResult: McpToolResult | undefined;
  };
}

const PLATFORM: HostPlatform = Platform.OS === "ios" || Platform.OS === "android" ? Platform.OS : "web";

/**
 * Renders an MCP tool's app through the shared AppFrame. `tools/call` and `resources/read` from
 * the view go to the daemon, which only acts on the app's own server (server/mcp-apps/calls.ts).
 */
export function McpAppFrame(props: McpAppFrameProps) {
  const callTool = useRpc(mcpAppsCallToolRpc);
  const readResource = useRpc(mcpAppsReadResourceRpc);
  const { server } = props.mcp;

  const services = useMemo<McpAppsServices>(
    () => ({
      async callTool(request) {
        const reply = await callTool({ server, name: request.name, arguments: request.arguments });
        if (!reply.ok) throw new Error(reply.error);
        return reply.result;
      },
      async readResource(request) {
        const reply = await readResource({ server, uri: request.uri });
        if (!reply.ok) throw new Error(reply.error);
        return { contents: reply.contents };
      },
    }),
    [callTool, readResource, server],
  );

  return (
    <AppFrame
      html={props.html}
      mode="mcp"
      agentId={props.agentId}
      appKey={props.appKey}
      csp={props.csp}
      theme={props.theme}
      platform={PLATFORM}
      server={server}
      toolName={props.mcp.toolName}
      toolInput={props.mcp.toolInput ? { ...props.mcp.toolInput } : undefined}
      toolResult={props.mcp.toolResult}
      resourceUri={props.appKey.slice(`mcp:${server}:`.length)}
      services={services}
    />
  );
}
