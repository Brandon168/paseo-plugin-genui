import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import React, { useEffect, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { mcpAppsResourceRpc, type McpAppCsp, type McpAppItemData } from "../../shared/mcp-apps-rpc";
import { McpAppFrame } from "./app-frame-adapter";
import { fallbackTextOf, toolResultOf } from "./tool-result";

type AppState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly html: string; readonly csp: McpAppCsp; readonly resourceUri: string }
  | { readonly status: "unavailable"; readonly error: string };

/**
 * The timeline row of an MCP tool that has an app: a header with the tool and its status, then
 * the app in MCP mode. When the app cannot be loaded, the tool's output text is shown instead.
 */
export function McpAppTimelineItem({ item, agentId, theme }: PluginTimelineItemProps<McpAppItemData>) {
  const data = item.data;
  const readResource = useRpc(mcpAppsResourceRpc);
  const [app, setApp] = useState<AppState>({ status: "loading" });

  useEffect(() => {
    let live = true;
    setApp({ status: "loading" });
    readResource({ server: data.server, tool: data.tool }).then(
      (result) => {
        if (!live) return;
        setApp(
          result.ok
            ? { status: "ready", html: result.html, csp: result.csp, resourceUri: result.resourceUri }
            : { status: "unavailable", error: result.error },
        );
      },
      () => {
        if (live) setApp({ status: "unavailable", error: "The app could not be loaded." });
      },
    );
    return () => {
      live = false;
    };
  }, [data.server, data.tool, readResource]);

  const toolResult = useMemo(() => toolResultOf(data), [data]);

  return (
    <View style={{ gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontFamily: "monospace" }}>
        {`${data.name} · ${data.status}`}
      </Text>
      {app.status === "ready" ? (
        <McpAppFrame
          html={app.html}
          mode="mcp"
          agentId={agentId}
          appKey={`mcp:${data.server}:${app.resourceUri}`}
          csp={app.csp}
          theme={theme}
          mcp={{ server: data.server, toolName: data.tool, toolInput: data.input, toolResult }}
        />
      ) : app.status === "loading" ? (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Loading app…</Text>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
          {fallbackTextOf(data) || app.error}
        </Text>
      )}
    </View>
  );
}
