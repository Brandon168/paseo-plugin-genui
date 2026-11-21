import type { PluginTheme } from "@getpaseo/plugin";
import React, { useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { ConsentGate } from "./consent";

function Button({
  label,
  onPress,
  theme,
  primary = false,
}: {
  label: string;
  onPress(): void;
  theme: PluginTheme;
  primary?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: primary ? theme.colors.accent : theme.colors.border,
        backgroundColor: primary ? theme.colors.accent : theme.colors.surface2,
      }}
    >
      <Text style={{ color: primary ? theme.colors.accentForeground : theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>
        {label}
      </Text>
    </Pressable>
  );
}

function Panel({ theme, children }: { theme: PluginTheme; children: React.ReactNode }) {
  return (
    <View
      style={{
        borderRadius: 10,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.statusWarning,
        backgroundColor: theme.colors.surface2,
        padding: 10,
        gap: 8,
      }}
    >
      {children}
    </View>
  );
}

/** What an app wants to do (send a message, open a link, ask the AI), exactly as it will happen. */
export function ConsentBanner({ gate, theme }: { gate: ConsentGate; theme: PluginTheme }) {
  const pending = useSyncExternalStore(gate.subscribe, () => gate.pending);
  const current = pending[0];
  if (current === undefined) return null;
  return (
    <Panel theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>{current.request.title}</Text>
      <ScrollView
        style={{ maxHeight: 140, borderRadius: 6, backgroundColor: theme.colors.surface0 }}
        contentContainerStyle={{ padding: 8 }}
        nestedScrollEnabled
      >
        <Text selectable style={{ color: theme.colors.foreground, fontSize: 12.5, fontFamily: "monospace" }}>
          {current.request.detail}
        </Text>
      </ScrollView>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
        <Button label="Allow" primary theme={theme} onPress={() => gate.decide(current.id, "allow")} />
        <Button label="Always for this app" theme={theme} onPress={() => gate.decide(current.id, "always")} />
        <Button label="Cancel" theme={theme} onPress={() => gate.decide(current.id, "cancel")} />
        {pending.length > 1 ? (
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>+{pending.length - 1} more waiting</Text>
        ) : null}
      </View>
    </Panel>
  );
}

/** One-time approval of the hosts an app wants to reach with fetch, XHR or WebSocket. */
export function ConnectApprovalCard({
  domains,
  rejected,
  theme,
  onAllow,
  onDeny,
}: {
  domains: readonly string[];
  rejected: readonly string[];
  theme: PluginTheme;
  onAllow(): void;
  onDeny(): void;
}) {
  return (
    <Panel theme={theme}>
      <Text style={{ color: theme.colors.foreground, fontSize: 12.5, fontWeight: "600" }}>This app wants to connect to:</Text>
      <View style={{ gap: 2 }}>
        {domains.map((domain) => (
          <Text key={domain} selectable style={{ color: theme.colors.foreground, fontSize: 12.5, fontFamily: "monospace" }}>
            {domain}
          </Text>
        ))}
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11.5 }}>
        Once allowed, the app can send anything it can read, including files the agent can load, to these hosts.
        {rejected.length > 0 ? ` Ignored as invalid: ${rejected.join(", ")}.` : ""}
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label="Allow" primary theme={theme} onPress={onAllow} />
        <Button label="Run without network" theme={theme} onPress={onDeny} />
      </View>
    </Panel>
  );
}
