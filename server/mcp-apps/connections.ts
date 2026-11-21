import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerSpec, McpTransport } from "./config";

export const MCP_REQUEST_TIMEOUT_MS = 30_000;
export const MCP_IDLE_CLOSE_MS = 10 * 60_000;

const MAX_TOOL_PAGES = 20;
const MAX_TOOLS = 1000;

const CLIENT_INFO = { name: "genui", version: "1.0.0" };

/** Advertised so servers register their UI tools (the MCP Apps client capability). */
const APPS_EXTENSION = {
  "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
};

export interface McpRequestOptions {
  /** Count the request as app use, which keeps the connection open. Default true. */
  readonly touch?: boolean;
}

export interface McpConnectionOptions {
  readonly now?: () => number;
  readonly requestTimeoutMs?: number;
  readonly idleCloseMs?: number;
}

export type McpCallResult = Awaited<ReturnType<Client["callTool"]>>;
export type McpReadResult = Awaited<ReturnType<Client["readResource"]>>;

interface Connection {
  readonly fingerprint: string;
  readonly client: Client;
  lastUsedAt: number;
}

/** Changes whenever the transport config changes, so an edited server reconnects. */
export function transportFingerprint(spec: McpServerSpec): string {
  return createHash("sha256").update(JSON.stringify(spec.transport)).digest("hex");
}

function createTransport(transport: McpTransport): Transport {
  if (transport.kind === "stdio") {
    const [executable, ...args] = transport.command;
    if (executable === undefined) throw new Error("the MCP command is empty");
    // The SDK merges its safe default environment with this one, so the daemon's own
    // environment does not reach the server process. stderr is dropped: it may echo secrets.
    return new StdioClientTransport({
      command: executable,
      args,
      env: { ...transport.environment },
      cwd: transport.cwd ?? undefined,
      stderr: "ignore",
    });
  }
  return new StreamableHTTPClientTransport(new URL(transport.url), {
    requestInit: { headers: { ...transport.headers } },
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * One MCP client per configured server. Connections start on first use, time out after
 * MCP_REQUEST_TIMEOUT_MS, and close after MCP_IDLE_CLOSE_MS without app use (see closeIdle).
 */
export class McpConnections {
  private readonly open = new Map<string, Connection>();
  private readonly connecting = new Map<string, { fingerprint: string; promise: Promise<Connection> }>();
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly idleCloseMs: number;
  private disposed = false;

  constructor(options: McpConnectionOptions = {}) {
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS;
    this.idleCloseMs = options.idleCloseMs ?? MCP_IDLE_CLOSE_MS;
  }

  isOpen(name: string): boolean {
    return this.open.has(name);
  }

  async listTools(spec: McpServerSpec, options: McpRequestOptions = {}): Promise<Tool[]> {
    return this.run(spec, options, async (client, timeout) => {
      const tools: Tool[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_TOOL_PAGES && tools.length < MAX_TOOLS; page++) {
        const result = await client.listTools(cursor === undefined ? undefined : { cursor }, { timeout });
        tools.push(...result.tools);
        if (!result.nextCursor) break;
        cursor = result.nextCursor;
      }
      return tools.slice(0, MAX_TOOLS);
    });
  }

  readResource(spec: McpServerSpec, uri: string, options: McpRequestOptions = {}): Promise<McpReadResult> {
    return this.run(spec, options, (client, timeout) => client.readResource({ uri }, { timeout }));
  }

  callTool(
    spec: McpServerSpec,
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpCallResult> {
    return this.run(spec, options, (client, timeout) =>
      client.callTool({ name, arguments: args }, undefined, { timeout }),
    );
  }

  /** Closes one server's connection; a server that is not open is a no-op. */
  async close(name: string): Promise<void> {
    const connection = this.open.get(name);
    this.open.delete(name);
    if (connection) await connection.client.close().catch(() => undefined);
  }

  /** Closes every connection idle for the idle limit. Returns how many closed. */
  async closeIdle(): Promise<number> {
    const now = this.now();
    const idle = [...this.open.entries()].filter(([, connection]) => now - connection.lastUsedAt >= this.idleCloseMs);
    await Promise.all(idle.map(([name]) => this.close(name)));
    return idle.length;
  }

  /** Ends every connection and kills stdio children. Connections started later are refused. */
  async closeAll(): Promise<void> {
    this.disposed = true;
    await Promise.all([...this.open.keys()].map((name) => this.close(name)));
  }

  private async run<T>(
    spec: McpServerSpec,
    options: McpRequestOptions,
    call: (client: Client, timeout: number) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connect(spec);
    if (options.touch !== false) connection.lastUsedAt = this.now();
    return call(connection.client, this.requestTimeoutMs);
  }

  private connect(spec: McpServerSpec): Promise<Connection> {
    if (this.disposed) return Promise.reject(new Error("MCP connections are closed"));
    const fingerprint = transportFingerprint(spec);
    const live = this.open.get(spec.name);
    if (live?.fingerprint === fingerprint) return Promise.resolve(live);
    const pending = this.connecting.get(spec.name);
    if (pending?.fingerprint === fingerprint) return pending.promise;

    const promise: Promise<Connection> = this.start(spec, fingerprint).finally(() => {
      if (this.connecting.get(spec.name)?.promise === promise) this.connecting.delete(spec.name);
    });
    this.connecting.set(spec.name, { fingerprint, promise });
    return promise;
  }

  private async start(spec: McpServerSpec, fingerprint: string): Promise<Connection> {
    // The config changed under an open connection: retire it before opening the new one.
    if (this.open.has(spec.name)) await this.close(spec.name);
    const client = new Client(CLIENT_INFO, { capabilities: { extensions: APPS_EXTENSION } });
    const transport = createTransport(spec.transport);
    try {
      await client.connect(transport, { timeout: this.requestTimeoutMs });
    } catch (error) {
      await client.close().catch(() => undefined);
      throw new Error(`MCP server "${spec.name}" did not start: ${reasonOf(error)}`);
    }
    if (this.disposed) {
      await client.close().catch(() => undefined);
      throw new Error("MCP connections are closed");
    }
    const connection: Connection = { fingerprint, client, lastUsedAt: this.now() };
    this.open.set(spec.name, connection);
    client.onclose = () => {
      if (this.open.get(spec.name) === connection) this.open.delete(spec.name);
    };
    return connection;
  }
}
