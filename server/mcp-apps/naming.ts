/**
 * Names agent providers give to MCP tools, so a `tool_call` row can be matched to its MCP tool.
 *
 * OpenCode (V1), `packages/opencode/src/mcp/catalog.ts` at anomalyco/opencode commit
 * fc7e4cf93e660ad5ddabb0c48ecc99e934ebfe95 (the upstream path was removed in 44b6938):
 *   sanitize = (value) => value.replace(/[^a-zA-Z0-9_-]/g, "_")
 *   toolName = (clientName, name) => sanitize(clientName) + "_" + sanitize(name)
 *
 * Claude: `mcp__<server>__<tool>`, the format the Paseo claude provider uses
 * (packages/server/src/server/agent/providers/claude/options.ts). The same sanitize rule is
 * applied to both parts here; Claude's own sanitize rule is not verified.
 */

export function sanitizeMcpName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function openCodeToolName(server: string, tool: string): string {
  return `${sanitizeMcpName(server)}_${sanitizeMcpName(tool)}`;
}

export function claudeToolName(server: string, tool: string): string {
  return `mcp__${sanitizeMcpName(server)}__${sanitizeMcpName(tool)}`;
}

/** Every provider spelling of one MCP tool, without duplicates. */
export function providerToolNames(server: string, tool: string): string[] {
  return [...new Set([openCodeToolName(server, tool), claudeToolName(server, tool)])];
}
