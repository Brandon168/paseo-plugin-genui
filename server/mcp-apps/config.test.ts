import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  globalOpencodeConfigFiles,
  loadMcpServers,
  parseJsonc,
  projectOpencodeConfigFiles,
  stripJsonc,
} from "./config";

let root: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(os.homedir(), "genui-mcp-config-test-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function writeConfig(dir: string, body: unknown, name = "opencode.json"): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
  return file;
}

describe("JSONC reading", () => {
  it("removes comments and trailing commas but keeps string contents", () => {
    const text = `{
      // a line comment
      "url": "https://example.test//path, }", /* block */
      "list": [1, 2,],
    }`;
    expect(parseJsonc(text)).toEqual({ url: "https://example.test//path, }", list: [1, 2] });
    expect(stripJsonc('"a\\"//b"')).toBe('"a\\"//b"');
  });
});

describe("OpenCode mcp config", () => {
  it("parses local and remote entries and skips the ones it cannot use", async () => {
    const dir = path.join(root, "global-shapes");
    const file = await writeConfig(dir, {
      mcp: {
        fs: {
          type: "local",
          command: ["npx", "-y", "fs-server", "{env:FS_ROOT}"],
          environment: { TOKEN: "{env:GENUI_TEST_TOKEN}" },
        },
        remote: {
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer {env:GENUI_TEST_KEY}" },
        },
        loopback: { type: "remote", url: "http://localhost:3000/mcp" },
        off: { type: "local", command: ["unused"], enabled: false },
        insecure: { type: "remote", url: "http://example.test/mcp" },
        sse: { type: "sse", url: "https://example.test/sse" },
        empty: { type: "local", command: [] },
      },
    });

    const result = await loadMcpServers([file], {
      FS_ROOT: "/srv/docs",
      GENUI_TEST_TOKEN: "t-1",
      GENUI_TEST_KEY: "k-1",
    });

    expect(result.servers).toEqual([
      {
        name: "fs",
        source: file,
        transport: {
          kind: "stdio",
          command: ["npx", "-y", "fs-server", "/srv/docs"],
          cwd: null,
          environment: { TOKEN: "t-1" },
        },
      },
      {
        name: "loopback",
        source: file,
        transport: { kind: "http", url: "http://localhost:3000/mcp", headers: {} },
      },
      {
        name: "remote",
        source: file,
        transport: {
          kind: "http",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: "Bearer k-1" },
        },
      },
    ]);
    expect(result.skipped.map((skip) => [skip.name, skip.reason])).toEqual([
      ["off", "disabled"],
      ["insecure", "url must be https (or http on localhost)"],
      ["sse", 'type must be "local" or "remote"'],
      ["empty", "command must be a non-empty list of strings"],
    ]);
  });

  it("never puts environment or header values in a skip reason", async () => {
    const dir = path.join(root, "secret-reasons");
    const file = await writeConfig(dir, {
      mcp: {
        bad: {
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { Authorization: 42 },
        },
      },
    });
    const result = await loadMcpServers([file], { SECRET_VALUE: "super-secret-value" });
    expect(result.servers).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
    expect(result.skipped[0]?.reason).toBe("headers must map names to strings");
  });

  it("lets a project file override a global entry and disable it", async () => {
    const globalFile = await writeConfig(path.join(root, "override", "global"), {
      mcp: {
        fs: { type: "local", command: ["global-fs"] },
        docs: {
          type: "remote",
          url: "https://docs.example.test/mcp",
          headers: { "X-Team": "global", "X-Keep": "yes" },
        },
      },
    });
    const projectFile = await writeConfig(path.join(root, "override", "project"), {
      mcp: {
        fs: { enabled: false },
        docs: { headers: { "X-Team": "project" } },
        tools: { type: "local", command: ["project-tools"] },
      },
    });

    const result = await loadMcpServers([globalFile, projectFile]);
    expect(result.servers.map((server) => server.name)).toEqual(["docs", "tools"]);
    const docs = result.servers.find((server) => server.name === "docs");
    expect(docs?.source).toBe(projectFile);
    expect(docs?.transport).toEqual({
      kind: "http",
      url: "https://docs.example.test/mcp",
      headers: { "X-Team": "project", "X-Keep": "yes" },
    });
    expect(result.skipped).toContainEqual({ name: "fs", source: projectFile, reason: "disabled" });
  });

  it("resolves a relative cwd from the directory of the file that defines the server", async () => {
    const dir = path.join(root, "cwd");
    const file = await writeConfig(dir, {
      mcp: { tools: { type: "local", command: ["run"], cwd: "./bin" } },
    });
    const result = await loadMcpServers([file]);
    expect(result.servers[0]?.transport).toMatchObject({ kind: "stdio", cwd: path.join(dir, "bin") });
  });

  it("reads {file:} references relative to the config directory", async () => {
    const dir = path.join(root, "file-ref");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "key.txt"), "from-file\n");
    const file = await writeConfig(dir, {
      mcp: {
        remote: {
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { "X-Key": "{file:key.txt}" },
        },
        broken: {
          type: "remote",
          url: "https://mcp.example.test/mcp",
          headers: { "X-Key": "{file:missing-key.txt}" },
        },
      },
    });
    const result = await loadMcpServers([file]);
    expect(result.servers).toEqual([
      expect.objectContaining({
        name: "remote",
        transport: expect.objectContaining({ headers: { "X-Key": "from-file" } }),
      }),
    ]);
    expect(result.skipped).toEqual([
      { name: "broken", source: file, reason: "a {file:} reference could not be read" },
    ]);
  });

  it("ignores missing files and reports unparseable ones without their contents", async () => {
    const good = await writeConfig(path.join(root, "parse", "good"), {
      mcp: { only: { type: "local", command: ["only"] } },
    });
    const bad = await writeConfig(path.join(root, "parse", "bad"), '{"mcp": {"secret": "leak-me",}', "opencode.json");
    const missing = path.join(root, "parse", "absent", "opencode.json");

    const result = await loadMcpServers([missing, bad, good]);
    expect(result.servers.map((server) => server.name)).toEqual(["only"]);
    expect(result.skipped).toEqual([{ name: "*", source: bad, reason: "config file is not valid JSON" }]);
    expect(JSON.stringify(result)).not.toContain("leak-me");
  });

  it("finds the global config under XDG_CONFIG_HOME when it is absolute", () => {
    expect(globalOpencodeConfigFiles({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toEqual([
      "/xdg/opencode/opencode.json",
      "/xdg/opencode/opencode.jsonc",
    ]);
    expect(globalOpencodeConfigFiles({ XDG_CONFIG_HOME: "relative" }, "/home/u")).toEqual([
      "/home/u/.config/opencode/opencode.json",
      "/home/u/.config/opencode/opencode.jsonc",
    ]);
    expect(projectOpencodeConfigFiles("/repo")).toEqual(["/repo/opencode.json", "/repo/opencode.jsonc"]);
  });
});
