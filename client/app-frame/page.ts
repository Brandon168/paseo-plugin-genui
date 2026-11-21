import type { PluginTheme } from "@getpaseo/plugin";
import { paseoVariables, type AppMode } from "./host-context";
import { PASEO_CLIENT_SOURCE } from "./paseo-client";

const BASE_STYLES = `*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:transparent}
html{color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.5}
code,kbd,pre,samp{font-family:ui-monospace,monospace}
img,video,canvas{max-width:100%}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
button{cursor:pointer;padding:6px 12px;border:1px solid var(--border);border-radius:8px;background:var(--background);line-height:1.25}
input,select,textarea{padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--background)}`;

function safeCssValue(value: string): string {
  return value.replace(/[;{}<>"'\\]/g, "");
}

/**
 * What goes into HtmlFrame's `html`: for ```app pages the base styles, the current theme variables,
 * the `window.paseo` client and then the page verbatim; for MCP views the page verbatim (they bring
 * the ext-apps SDK and style themselves from the host context). The host adds doctype, CSP, viewport
 * and its own bootstrap in front.
 */
export function buildPageHtml(html: string, theme: PluginTheme, mode: AppMode): string {
  if (mode === "mcp") return html;
  const variables = Object.entries(paseoVariables(theme))
    .map(([name, value]) => `${name}:${safeCssValue(value)}`)
    .join(";");
  return [
    `<style>${BASE_STYLES}</style>`,
    `<style id="genui-theme">:root{${variables}}</style>`,
    `<script>${PASEO_CLIENT_SOURCE}</script>`,
    html,
  ].join("\n");
}
