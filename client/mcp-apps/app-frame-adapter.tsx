import type { PluginTheme } from "@getpaseo/plugin";
import React from "react";
import { Text, View } from "react-native";
import type { McpToolResult } from "./tool-result";

/**
 * Props of slice B's `AppFrame` in `mcp` mode, as spec section B defines them. The renderer is
 * written against this shape only.
 */
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

/**
 * Placeholder until slice B's AppFrame is merged. The coordinator replaces this module's
 * export with the real component (same props); nothing else in client/mcp-apps imports the frame.
 */
export function McpAppFrame(props: McpAppFrameProps) {
  const { theme, mcp } = props;
  return (
    <View
      style={{
        borderWidth: 1,
        borderRadius: 8,
        padding: 10,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {`App ${mcp.server}/${mcp.toolName}: the app frame is not wired yet.`}
      </Text>
    </View>
  );
}
