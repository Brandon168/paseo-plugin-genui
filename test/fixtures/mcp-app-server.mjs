// Stdio MCP server for the genui MCP Apps tests (spawned by the tests, not part of the plugin).
//
// Tools:
//   show_dashboard    UI tool, visible to the model and to apps
//   refresh_dashboard UI tool, app-only (visibility ["app"])
//   model_only_view   UI tool, model-only (visibility ["model"]); apps must be refused
//   legacy_view       UI tool declared with the flat "ui/resourceUri" key; visibility defaults
//   broken_view       UI tool whose resource has the wrong MIME type
//   slow_refresh      app-only tool that answers after 2 s (request-timeout tests)
//   plain_lookup      no _meta at all; apps must be refused
//
// Resources: ui://fixture/dashboard (MCP Apps HTML with a declared CSP), ui://fixture/broken.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const DASHBOARD_URI = "ui://fixture/dashboard";
const BROKEN_URI = "ui://fixture/broken";
const DASHBOARD_HTML =
  "<!doctype html><html><body><h1>Fixture dashboard</h1><script>window.fixture = true;</script></body></html>";

const TOOLS = [
  {
    name: "show_dashboard",
    description: "Show the dashboard for a city.",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["model", "app"] } },
  },
  {
    name: "refresh_dashboard",
    description: "Refresh the dashboard (apps only).",
    inputSchema: { type: "object", properties: { city: { type: "string" } } },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } },
  },
  {
    name: "model_only_view",
    description: "A UI tool the model may call but apps may not.",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["model"] } },
  },
  {
    name: "legacy_view",
    description: "A UI tool declared with the flat legacy key.",
    inputSchema: { type: "object" },
    _meta: { "ui/resourceUri": DASHBOARD_URI },
  },
  {
    name: "broken_view",
    description: "A UI tool whose resource is not an MCP Apps document.",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: BROKEN_URI } },
  },
  {
    name: "slow_refresh",
    description: "Answers after two seconds.",
    inputSchema: { type: "object" },
    _meta: { ui: { resourceUri: DASHBOARD_URI, visibility: ["app"] } },
  },
  {
    name: "plain_lookup",
    description: "A tool with no UI.",
    inputSchema: { type: "object", properties: { term: { type: "string" } } },
  },
];

const server = new Server(
  { name: "genui-mcp-app-fixture", version: "1.0.0" },
  { capabilities: { tools: {}, resources: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};
  if (name === "slow_refresh") {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return { content: [{ type: "text", text: "slow done" }] };
  }
  if (name === "show_dashboard" || name === "refresh_dashboard") {
    const city = typeof args.city === "string" ? args.city : "Lisbon";
    return {
      content: [{ type: "text", text: `Dashboard for ${city}` }],
      structuredContent: { city, temperature: 21 },
    };
  }
  if (name === "model_only_view" || name === "legacy_view" || name === "broken_view" || name === "plain_lookup") {
    return { content: [{ type: "text", text: `${name} ran` }] };
  }
  return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    { uri: DASHBOARD_URI, name: "dashboard", mimeType: "text/html;profile=mcp-app" },
    { uri: BROKEN_URI, name: "broken", mimeType: "text/plain" },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const uri = request.params.uri;
  if (uri === DASHBOARD_URI) {
    return {
      contents: [
        {
          uri,
          mimeType: "text/html;profile=mcp-app",
          text: DASHBOARD_HTML,
          _meta: {
            ui: {
              csp: {
                connectDomains: ["https://api.example.test"],
                resourceDomains: ["https://cdn.example.test"],
                frameDomains: ["https://frames.example.test"],
              },
            },
          },
        },
      ],
    };
  }
  if (uri === BROKEN_URI) {
    return { contents: [{ uri, mimeType: "text/plain", text: "not an app" }] };
  }
  throw new Error(`no resource ${uri}`);
});

await server.connect(new StdioServerTransport());
