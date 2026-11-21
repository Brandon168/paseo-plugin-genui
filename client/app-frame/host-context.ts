import type { PluginTheme } from "@getpaseo/plugin";
import type { DisplayMode } from "./protocol";

export type AppMode = "genui" | "mcp";
export type HostPlatform = "ios" | "android" | "web";

export interface HostContext {
  toolInfo?: { tool: { name: string; inputSchema: { type: "object" } } };
  theme: "light" | "dark";
  styles: { variables: Record<string, string> };
  displayMode: DisplayMode;
  availableDisplayModes: DisplayMode[];
  containerDimensions: { maxHeight: number } | { width: number; height: number };
  locale: string;
  timeZone: string;
  userAgent: string;
  platform: "web" | "mobile";
  deviceCapabilities: { touch: boolean; hover: boolean };
}

/** "dark" when the page background is dark. The plugin theme has no scheme flag, so read the colour. */
export function themeScheme(theme: PluginTheme): "light" | "dark" {
  const color = theme.colors.surface0.trim();
  let rgb: [number, number, number] | null = null;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (hex?.[1] !== undefined) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((char) => char + char).join("") : hex[1];
    rgb = [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
  } else {
    const parts = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(color);
    if (parts !== null) rgb = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  }
  if (rgb === null) return "dark";
  const luminance = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
  return luminance < 0.5 ? "dark" : "light";
}

/** Paseo's own variable names, the ones ```app pages have always used. */
export function paseoVariables(theme: PluginTheme): Record<string, string> {
  const c = theme.colors;
  return {
    "--background": c.surface0,
    "--card": c.surface1,
    "--muted": c.surface2,
    "--border": c.border,
    "--foreground": c.foreground,
    "--muted-foreground": c.foregroundMuted,
    "--subtle-foreground": c.foregroundMuted,
    "--primary": c.accent,
    "--primary-foreground": c.accentForeground,
    "--accent": c.accent,
    "--success": c.statusSuccess,
    "--warning": c.statusWarning,
    "--destructive": c.statusDanger,
  };
}

/** The MCP Apps standard style variables (spec 2026-01-26, "Theming"), mapped onto the Paseo theme. */
export function mcpStyleVariables(theme: PluginTheme): Record<string, string> {
  const c = theme.colors;
  const sans = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  return {
    "--color-background-primary": c.surface0,
    "--color-background-secondary": c.surface1,
    "--color-background-tertiary": c.surface2,
    "--color-background-inverse": c.foreground,
    "--color-background-ghost": "transparent",
    "--color-background-info": c.surface1,
    "--color-background-danger": c.surface1,
    "--color-background-success": c.surface1,
    "--color-background-warning": c.surface1,
    "--color-background-disabled": c.surface2,
    "--color-text-primary": c.foreground,
    "--color-text-secondary": c.foregroundMuted,
    "--color-text-tertiary": c.foregroundMuted,
    "--color-text-inverse": c.surface0,
    "--color-text-info": c.accent,
    "--color-text-danger": c.statusDanger,
    "--color-text-success": c.statusSuccess,
    "--color-text-warning": c.statusWarning,
    "--color-text-disabled": c.foregroundMuted,
    "--color-text-ghost": c.foregroundMuted,
    "--color-border-primary": c.border,
    "--color-border-secondary": c.border,
    "--color-border-tertiary": c.border,
    "--color-border-inverse": c.foreground,
    "--color-border-ghost": "transparent",
    "--color-border-info": c.accent,
    "--color-border-danger": c.statusDanger,
    "--color-border-success": c.statusSuccess,
    "--color-border-warning": c.statusWarning,
    "--color-border-disabled": c.border,
    "--color-ring-primary": c.accent,
    "--color-ring-secondary": c.border,
    "--color-ring-inverse": c.foreground,
    "--color-ring-info": c.accent,
    "--color-ring-danger": c.statusDanger,
    "--color-ring-success": c.statusSuccess,
    "--color-ring-warning": c.statusWarning,
    "--font-sans": sans,
    "--font-mono": mono,
    "--font-weight-normal": "400",
    "--font-weight-medium": "500",
    "--font-weight-semibold": "600",
    "--font-weight-bold": "700",
    "--font-text-xs-size": "11px",
    "--font-text-sm-size": "12.5px",
    "--font-text-md-size": "14px",
    "--font-text-lg-size": "16px",
    "--font-heading-xs-size": "14px",
    "--font-heading-sm-size": "16px",
    "--font-heading-md-size": "18px",
    "--font-heading-lg-size": "22px",
    "--font-heading-xl-size": "26px",
    "--font-heading-2xl-size": "32px",
    "--font-heading-3xl-size": "40px",
    "--font-text-xs-line-height": "1.4",
    "--font-text-sm-line-height": "1.45",
    "--font-text-md-line-height": "1.5",
    "--font-text-lg-line-height": "1.5",
    "--font-heading-xs-line-height": "1.35",
    "--font-heading-sm-line-height": "1.35",
    "--font-heading-md-line-height": "1.3",
    "--font-heading-lg-line-height": "1.25",
    "--font-heading-xl-line-height": "1.2",
    "--font-heading-2xl-line-height": "1.15",
    "--font-heading-3xl-line-height": "1.1",
    "--border-radius-xs": "2px",
    "--border-radius-sm": "4px",
    "--border-radius-md": "8px",
    "--border-radius-lg": "12px",
    "--border-radius-xl": "16px",
    "--border-radius-full": "9999px",
    "--border-width-regular": "1px",
    "--shadow-hairline": `0 0 0 1px ${c.border}`,
    "--shadow-sm": "0 1px 2px rgba(0,0,0,0.12)",
    "--shadow-md": "0 4px 8px rgba(0,0,0,0.16)",
    "--shadow-lg": "0 10px 24px rgba(0,0,0,0.2)",
  };
}

export interface HostContextInput {
  readonly theme: PluginTheme;
  readonly mode: AppMode;
  readonly displayMode: DisplayMode;
  readonly platform: HostPlatform;
  /** Fullscreen only: the real container. Inline pages size themselves up to the app height cap. */
  readonly container?: { readonly width: number; readonly height: number };
  readonly maxInlineHeight: number;
  readonly toolName?: string;
  readonly locale?: string;
  readonly timeZone?: string;
  readonly version: string;
}

function resolvedLocale(): { locale: string; timeZone: string } {
  try {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    return { locale: options.locale || "en-US", timeZone: options.timeZone || "UTC" };
  } catch {
    return { locale: "en-US", timeZone: "UTC" };
  }
}

/** Paseo's variables for ```app pages, both families for MCP views (they ignore ones they do not know). */
export function buildStyleVariables(theme: PluginTheme, mode: AppMode): Record<string, string> {
  return mode === "genui" ? { ...mcpStyleVariables(theme), ...paseoVariables(theme) } : mcpStyleVariables(theme);
}

export function buildHostContext(input: HostContextInput): HostContext {
  const fallback = resolvedLocale();
  const mobile = input.platform !== "web";
  return {
    ...(input.toolName === undefined ? {} : { toolInfo: { tool: { name: input.toolName, inputSchema: { type: "object" as const } } } }),
    theme: themeScheme(input.theme),
    styles: { variables: buildStyleVariables(input.theme, input.mode) },
    displayMode: input.displayMode,
    availableDisplayModes: ["inline", "fullscreen"],
    containerDimensions:
      input.displayMode === "fullscreen" && input.container !== undefined
        ? { width: Math.round(input.container.width), height: Math.round(input.container.height) }
        : { maxHeight: input.maxInlineHeight },
    locale: input.locale ?? fallback.locale,
    timeZone: input.timeZone ?? fallback.timeZone,
    userAgent: `Paseo/${input.version}`,
    platform: mobile ? "mobile" : "web",
    deviceCapabilities: { touch: mobile, hover: !mobile },
  };
}

export function hostCapabilities(
  mode: AppMode,
  approved: { readonly connectDomains: readonly string[]; readonly resourceDomains: readonly string[] },
  mcpAvailable: boolean,
): Record<string, unknown> {
  return {
    openLinks: {},
    logging: {},
    message: { text: {} },
    ...(mode === "mcp" && mcpAvailable ? { serverTools: {}, serverResources: {} } : {}),
    sandbox: {
      csp: {
        ...(approved.connectDomains.length > 0 ? { connectDomains: [...approved.connectDomains] } : {}),
        ...(approved.resourceDomains.length > 0 ? { resourceDomains: [...approved.resourceDomains] } : {}),
      },
    },
  };
}
