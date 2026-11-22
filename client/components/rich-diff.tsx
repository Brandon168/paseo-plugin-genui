import type { PluginTheme } from "@getpaseo/plugin";
import { openExternalUrl } from "@getpaseo/plugin/client";
import { memo } from "react";
import { StyleSheet, Text, View, type TextStyle } from "react-native";
import { tint } from "../../shared/logic/color";
import type { Change, RichRow, Span } from "../../shared/logic/rich-diff";

type Theme = PluginTheme;

const HEADING_SIZE: Record<number, number> = { 1: 6, 2: 4, 3: 2 };

/**
 * The formatted diff: the draft as the preview shows it (bold, links, lists, paragraphs), with
 * inserted words highlighted green, removed words struck red and restyled words amber.
 */
export const RichDiffView = memo(function RichDiffView({ rows, theme, size, selectable = true }: { rows: readonly RichRow[]; theme: Theme; size: number; selectable?: boolean }) {
  const c = theme.colors;
  const line = size + 7;
  const base: TextStyle = { color: c.foreground, fontSize: size, lineHeight: line };
  const insBg = tint(c.statusSuccess, 0.22);
  const delBg = tint(c.statusDanger, 0.18);
  const fmtBg = tint(c.statusWarning, 0.3);
  const barColor: Record<Change, string> = { eq: "transparent", ins: c.statusSuccess, del: c.statusDanger, fmt: c.statusWarning };

  const spanStyle = (s: Span, rowKind: RichRow["kind"]): TextStyle => {
    const st: TextStyle = {};
    if (s.fmt.b) st.fontWeight = "700";
    if (s.fmt.i) st.fontStyle = "italic";
    if (s.fmt.c || rowKind === "code") {
      st.fontFamily = "monospace";
      st.fontSize = size - 1;
      st.backgroundColor = c.surface1;
    }
    const lines: string[] = [];
    if (s.fmt.href) {
      // The accent is dim on a highlight (dark theme); a changed link keeps only its underline.
      st.color = s.change === "eq" ? c.accent : c.foreground;
      lines.push("underline");
    }
    if (s.fmt.s) lines.push("line-through");
    if (s.change === "ins") st.backgroundColor = insBg;
    else if (s.change === "fmt") st.backgroundColor = fmtBg;
    else if (s.change === "del") {
      st.backgroundColor = delBg;
      st.color = c.statusDanger;
      lines.push("line-through");
    }
    if (lines.length) st.textDecorationLine = [...new Set(lines)].join(" ") as TextStyle["textDecorationLine"];
    return st;
  };

  const markerStyle = (change: Change | "old"): TextStyle =>
    change === "ins" || change === "fmt"
      ? { backgroundColor: change === "ins" ? insBg : fmtBg, color: c.foreground }
      : { backgroundColor: delBg, color: c.statusDanger, textDecorationLine: "line-through" };

  return (
    <View style={{ gap: 0 }}>
      {rows.map((row, i) => {
        const prev = rows[i - 1];
        const tight = prev !== undefined && prev.kind === "li" && row.kind === "li";
        const top = i === 0 ? 0 : tight ? 2 : size * 0.55;
        if (row.kind === "hr") {
          return <View key={i} style={{ height: StyleSheet.hairlineWidth, backgroundColor: row.mark === "ins" ? c.statusSuccess : c.border, marginTop: top + 4, marginBottom: 4 }} />;
        }
        const heading = row.kind === "h";
        const text: TextStyle = {
          ...base,
          ...(heading ? { fontSize: size + (HEADING_SIZE[row.level] ?? 1), lineHeight: line + 3, fontWeight: "700" as const } : {}),
          ...(row.kind === "q" ? { color: c.foregroundMuted } : {}),
        };
        const markers =
          row.kind === "li" ? (
            <View style={{ flexDirection: "row", gap: 3, marginRight: 6, minWidth: 14 }}>
              {row.oldMarker ? <Text style={[text, markerStyle("old")]}>{row.oldMarker}</Text> : null}
              {row.marker ? <Text style={[text, { color: c.foregroundMuted }, row.mark === "eq" ? null : markerStyle(row.mark === "del" ? "old" : row.mark)]}>{row.marker}</Text> : null}
            </View>
          ) : row.oldMarker ? (
            <Text style={[text, markerStyle("old"), { marginRight: 6, alignSelf: "flex-start" }]}>{row.oldMarker}</Text>
          ) : null;
        return (
          <View
            key={i}
            style={[
              { flexDirection: "row", alignItems: "flex-start", marginTop: top, borderLeftWidth: 3, borderLeftColor: barColor[row.mark], paddingLeft: 6, marginLeft: -9 + row.level * 14 },
              row.kind === "q" ? { borderLeftColor: row.mark === "eq" ? c.border : barColor[row.mark], borderLeftWidth: 3 } : null,
              row.kind === "code" ? { backgroundColor: c.surface1, borderRadius: 6, paddingVertical: 4, paddingRight: 6 } : null,
            ]}
          >
            {markers}
            <Text selectable={selectable} style={[text, { flexShrink: 1, flexGrow: 1 }]}>
              {row.spans.map((s, k) => {
                const press = s.fmt.href && s.change !== "del" ? () => void openExternalUrl(s.fmt.href!) : undefined;
                return (
                  <Text key={k} style={spanStyle(s, row.kind)} onPress={press} accessibilityRole={press ? "link" : undefined}>
                    {s.text}
                  </Text>
                );
              })}
            </Text>
          </View>
        );
      })}
    </View>
  );
});
