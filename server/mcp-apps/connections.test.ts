import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpServerSpec } from "./config";
import { McpConnections } from "./connections";

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp-app-server.mjs", import.meta.url));
const SLOW_TEST_MS = 30_000;

const fixtureSpec: McpServerSpec = {
  name: "fixture",
  source: "test",
  transport: { kind: "stdio", command: [process.execPath, FIXTURE], cwd: null, environment: {} },
};

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text);
}

/** A stateless Streamable HTTP MCP server that accepts only requests carrying `x-genui-test`. */
function startHttpFixture(requiredValue: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const http: HttpServer = createServer(async (request, response) => {
    if (request.headers["x-genui-test"] !== requiredValue) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    const server = new Server({ name: "genui-http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "http_view",
          inputSchema: { type: "object" },
          _meta: { ui: { resourceUri: "ui://http/app", visibility: ["model", "app"] } },
        },
      ],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response, request.method === "POST" ? await readBody(request) : undefined);
  });
  return new Promise((resolve) => {
    http.listen(0, "127.0.0.1", () => {
      const { port } = http.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        stop: () => new Promise((done) => http.close(() => done())),
      });
    });
  });
}

describe("McpConnections over stdio", () => {
  let connections: McpConnections;

  beforeEach(() => {
    connections = new McpConnections({ requestTimeoutMs: 5_000 });
  });

  afterEach(async () => {
    await connections.closeAll();
  });

  it(
    "lists tools with their _meta and reads a ui:// resource with its declared CSP",
    async () => {
      const tools = await connections.listTools(fixtureSpec);
      expect(tools.map((tool) => tool.name).sort()).toEqual([
        "broken_view",
        "legacy_view",
        "model_only_view",
        "plain_lookup",
        "refresh_dashboard",
        "show_dashboard",
        "slow_refresh",
      ]);
      const show = tools.find((tool) => tool.name === "show_dashboard");
      expect(show?._meta).toEqual({ ui: { resourceUri: "ui://fixture/dashboard", visibility: ["model", "app"] } });

      const read = await connections.readResource(fixtureSpec, "ui://fixture/dashboard");
      const content = read.contents[0] as Record<string, unknown>;
      expect(content.mimeType).toBe("text/html;profile=mcp-app");
      expect(String(content.text)).toContain("Fixture dashboard");
      expect(content._meta).toEqual({
        ui: {
          csp: {
            connectDomains: ["https://api.example.test"],
            resourceDomains: ["https://cdn.example.test"],
            frameDomains: ["https://frames.example.test"],
          },
        },
      });
    },
    SLOW_TEST_MS,
  );

  it(
    "calls a tool and keeps its structuredContent",
    async () => {
      const result = await connections.callTool(fixtureSpec, "show_dashboard", { city: "Porto" });
      expect(result.structuredContent).toEqual({ city: "Porto", temperature: 21 });
      expect(result.content).toEqual([{ type: "text", text: "Dashboard for Porto" }]);
    },
    SLOW_TEST_MS,
  );

  it(
    "times out a slow request, and the connection still serves the next one",
    async () => {
      const impatient = new McpConnections({ requestTimeoutMs: 1_000 });
      try {
        await expect(impatient.callTool(fixtureSpec, "slow_refresh", {})).rejects.toThrow(/timed out/i);
        const next = await impatient.callTool(fixtureSpec, "plain_lookup", { term: "x" });
        expect(next.content).toEqual([{ type: "text", text: "plain_lookup ran" }]);
      } finally {
        await impatient.closeAll();
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "closes a connection after the idle limit, and app use keeps it open",
    async () => {
      let clock = 1_000;
      const idle = new McpConnections({ now: () => clock, idleCloseMs: 60_000 });
      try {
        await idle.listTools(fixtureSpec, { touch: false });
        expect(idle.isOpen("fixture")).toBe(true);

        clock += 59_000;
        expect(await idle.closeIdle()).toBe(0);
        clock += 1_000;
        expect(await idle.closeIdle()).toBe(1);
        expect(idle.isOpen("fixture")).toBe(false);

        await idle.readResource(fixtureSpec, "ui://fixture/dashboard");
        clock += 50_000;
        await idle.callTool(fixtureSpec, "plain_lookup", {});
        clock += 50_000;
        expect(await idle.closeIdle()).toBe(0);
        expect(idle.isOpen("fixture")).toBe(true);
      } finally {
        await idle.closeAll();
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "refuses new work after closeAll",
    async () => {
      await connections.listTools(fixtureSpec);
      await connections.closeAll();
      expect(connections.isOpen("fixture")).toBe(false);
      await expect(connections.listTools(fixtureSpec)).rejects.toThrow(/closed/);
    },
    SLOW_TEST_MS,
  );
});

describe("McpConnections over streamable HTTP", () => {
  it(
    "sends the configured headers and lists tools",
    async () => {
      const http = await startHttpFixture("expected-value");
      const connections = new McpConnections({ requestTimeoutMs: 5_000 });
      try {
        const spec: McpServerSpec = {
          name: "remote",
          source: "test",
          transport: {
            kind: "http",
            url: http.url,
            headers: { "x-genui-test": "expected-value" },
          },
        };
        const tools = await connections.listTools(spec);
        expect(tools.map((tool) => tool.name)).toEqual(["http_view"]);
        expect(tools[0]?._meta).toEqual({ ui: { resourceUri: "ui://http/app", visibility: ["model", "app"] } });
      } finally {
        await connections.closeAll();
        await http.stop();
      }
    },
    SLOW_TEST_MS,
  );

  it(
    "reports a server that refuses the connection without echoing the header value",
    async () => {
      const http = await startHttpFixture("expected-value");
      const connections = new McpConnections({ requestTimeoutMs: 5_000 });
      try {
        const spec: McpServerSpec = {
          name: "remote",
          source: "test",
          transport: { kind: "http", url: http.url, headers: { "x-genui-test": "wrong-value" } },
        };
        const error: unknown = await connections.listTools(spec).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/did not start/);
        expect((error as Error).message).not.toContain("wrong-value");
      } finally {
        await connections.closeAll();
        await http.stop();
      }
    },
    SLOW_TEST_MS,
  );
});
