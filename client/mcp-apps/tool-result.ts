import type { McpAppItemData } from "../../shared/mcp-apps-rpc";

export interface McpToolResult {
  readonly content: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
  readonly isError?: boolean;
}

/**
 * The CallToolResult an app receives (`ui/notifications/tool-result`), built from the row. It
 * uses the content blocks the provider kept, else the output text. A failed or canceled call is
 * an error result, so the app's own loading state ends. Undefined while the call runs.
 *
 * Canceled calls: the spec's `ui/notifications/tool-cancelled` is not in the frame props yet, so
 * a cancel is reported as an error result instead.
 */
export function toolResultOf(data: McpAppItemData): McpToolResult | undefined {
  if (data.status === "running") return undefined;
  const failed = data.status !== "completed";
  const text =
    data.output ?? data.error ?? (data.status === "canceled" ? "The tool call was canceled." : "");
  return {
    content: data.content ?? [{ type: "text", text }],
    ...(data.structuredContent ? { structuredContent: data.structuredContent } : {}),
    ...(failed ? { isError: true } : {}),
  };
}

/** The text an output row shows when the app itself cannot be shown. */
export function fallbackTextOf(data: McpAppItemData): string {
  return data.output ?? data.error ?? "";
}
