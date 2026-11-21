import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * MCP Apps (spec 2026-01-26): an MCP tool whose result has an interactive UI.
 * The chat keeps a plugin timeline item of this kind next to the tool call, and its renderer
 * shows the server's `ui://` resource in an app frame.
 */
export const MCP_APP_ITEM_KIND = "genui-mcp-app";
export const MCP_APP_ITEM_VERSION = 1;

/** The MIME type of an MCP Apps HTML resource (the only one rendered). */
export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

export const MAX_MCP_NAME_CHARS = 200;
export const MAX_MCP_APP_INDEX_ENTRIES = 500;
export const MAX_MCP_APP_CONTENT_BLOCKS = 100;
export const MAX_MCP_APP_CSP_DOMAINS = 50;

const mcpNameSchema = z.string().min(1).max(MAX_MCP_NAME_CHARS);
const jsonObjectSchema = z.record(z.string(), z.unknown());

/** One UI tool. `toolNames` are the spellings each agent provider uses for the same tool. */
export const mcpAppIndexEntrySchema = z.object({
  toolNames: z.array(z.string().min(1).max(MAX_MCP_NAME_CHARS)).min(1).max(4),
  server: mcpNameSchema,
  tool: mcpNameSchema,
});

export type McpAppIndexEntry = z.infer<typeof mcpAppIndexEntrySchema>;

export const mcpAppsIndexRpc = defineRpc({
  name: "genui.mcp_apps_index",
  input: z.object({ force: z.boolean().optional() }),
  output: z.object({ entries: z.array(mcpAppIndexEntrySchema).max(MAX_MCP_APP_INDEX_ENTRIES) }),
});

export const mcpAppCspSchema = z.object({
  connectDomains: z.array(z.string().min(1).max(300)).max(MAX_MCP_APP_CSP_DOMAINS),
  resourceDomains: z.array(z.string().min(1).max(300)).max(MAX_MCP_APP_CSP_DOMAINS),
});

export type McpAppCsp = z.infer<typeof mcpAppCspSchema>;

export const mcpAppResourceResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    html: z.string(),
    csp: mcpAppCspSchema,
    resourceUri: z.string().min(1).max(2048),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type McpAppResourceResult = z.infer<typeof mcpAppResourceResultSchema>;

/** The `ui://` document of a UI tool, plus the CSP the server declared for it. */
export const mcpAppsResourceRpc = defineRpc({
  name: "genui.mcp_apps_resource",
  input: z.object({ server: mcpNameSchema, tool: mcpNameSchema }),
  output: mcpAppResourceResultSchema,
});

export const mcpAppCallResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      content: z.array(jsonObjectSchema).max(MAX_MCP_APP_CONTENT_BLOCKS),
      structuredContent: jsonObjectSchema.optional(),
      isError: z.boolean().optional(),
    }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type McpAppCallResult = z.infer<typeof mcpAppCallResultSchema>;

/** `tools/call` from an app. Only tools the server marks app-visible; only that server. */
export const mcpAppsCallToolRpc = defineRpc({
  name: "genui.mcp_apps_call_tool",
  input: z.object({
    server: mcpNameSchema,
    name: mcpNameSchema,
    arguments: jsonObjectSchema.optional(),
  }),
  output: mcpAppCallResultSchema,
});

export const mcpAppReadResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    contents: z
      .array(
        z.object({
          uri: z.string().min(1).max(2048),
          mimeType: z.string().max(200).optional(),
          text: z.string().optional(),
          blob: z.string().optional(),
        }),
      )
      .max(20),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export type McpAppReadResult = z.infer<typeof mcpAppReadResultSchema>;

/** `resources/read` from an app, limited to the server that owns the app. */
export const mcpAppsReadResourceRpc = defineRpc({
  name: "genui.mcp_apps_read_resource",
  input: z.object({ server: mcpNameSchema, uri: z.string().min(1).max(2048) }),
  output: mcpAppReadResultSchema,
});

/**
 * Data of a `genui-mcp-app` timeline item. The transformer copies these fields from the
 * `tool_call` row it replaces, so the chat still shows the tool's name, status and output.
 * `content` and `structuredContent` come from the provider's stored MCP result when it kept
 * one (OpenCode V1 keeps the whole CallToolResult in the tool part's metadata).
 */
export const mcpAppItemDataSchema = z.object({
  server: mcpNameSchema,
  tool: mcpNameSchema,
  name: z.string().max(MAX_MCP_NAME_CHARS * 2),
  callId: z.string().min(1).max(256),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  input: jsonObjectSchema.nullable(),
  output: z.string().nullable(),
  content: z.array(jsonObjectSchema).max(MAX_MCP_APP_CONTENT_BLOCKS).nullable(),
  structuredContent: jsonObjectSchema.nullable(),
  error: z.string().max(4000).nullable(),
});

export type McpAppItemData = z.infer<typeof mcpAppItemDataSchema>;
