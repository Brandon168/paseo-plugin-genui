import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appAiRpc, appApprovalsRpc, appDownloadRpc, appLoadRpc, appStorageRpc } from "../../shared/app-rpc";
import { APP_LIMITS, appFileId } from "../../shared/app-util";
import { agentStorageDir } from "../data-source";
import { AiRateLimiter, claudeArgs, parseClaudeJson } from "./ai";
import { saveDownload } from "./download";
import { loadForApp } from "./index";
import { approvalsOp, appDataDir, resetAllApprovals, storageOp } from "./store";

let root: string;
const made: string[] = [];

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "genui-app-host-"));
  made.push(root);
});

afterAll(async () => {
  await Promise.all(made.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("app storage", () => {
  it("round-trips JSON values and lists sorted keys", async () => {
    expect(await storageOp(root, "budget", { type: "get", key: "a" })).toEqual({ ok: true, value: null });
    expect((await storageOp(root, "budget", { type: "set", key: "b", value: { n: [1, "x", null] } })).ok).toBe(true);
    await storageOp(root, "budget", { type: "set", key: "a", value: "text" });
    expect(await storageOp(root, "budget", { type: "get", key: "b" })).toEqual({ ok: true, value: { n: [1, "x", null] } });
    expect(await storageOp(root, "budget", { type: "keys" })).toEqual({ ok: true, value: null, keys: ["a", "b"] });
    await storageOp(root, "budget", { type: "delete", key: "a" });
    expect(await storageOp(root, "budget", { type: "keys" })).toEqual({ ok: true, value: null, keys: ["b"] });
    expect(await storageOp(root, "budget", { type: "delete", key: "nope" })).toEqual({ ok: true, value: null });
  });

  it("keeps apps apart and persists on disk under <storage>/apps/<slug>.json", async () => {
    await storageOp(root, "one", { type: "set", key: "k", value: 1 });
    await storageOp(root, "two", { type: "set", key: "k", value: 2 });
    expect(await storageOp(root, "one", { type: "get", key: "k" })).toMatchObject({ value: 1 });
    expect(await storageOp(root, "two", { type: "get", key: "k" })).toMatchObject({ value: 2 });
    const file = JSON.parse(await readFile(path.join(root, "apps", "one.json"), "utf8"));
    expect(file).toEqual({ version: 1, entries: { k: 1 } });
    expect((await stat(path.join(root, "apps", "one.json"))).mode & 0o777).toBe(0o600);
  });

  it("enforces the 1 MB cap per app and still allows replacing a value within it", async () => {
    const big = "x".repeat(600 * 1024);
    expect((await storageOp(root, "cap", { type: "set", key: "a", value: big })).ok).toBe(true);
    const second = await storageOp(root, "cap", { type: "set", key: "b", value: big });
    expect(second).toEqual({ ok: false, error: "app storage is full (1 MB per app)" });
    expect(await storageOp(root, "cap", { type: "get", key: "b" })).toMatchObject({ value: null });
    expect((await storageOp(root, "cap", { type: "set", key: "a", value: "small" })).ok).toBe(true);
    expect((await storageOp(root, "cap", { type: "set", key: "b", value: big })).ok).toBe(true);
    expect((await stat(path.join(root, "apps", "cap.json"))).size).toBeLessThanOrEqual(APP_LIMITS.storageBytes);
  });

  it("caps the number of keys", async () => {
    for (let index = 0; index < 1000; index++) {
      const result = await storageOp(root, "many", { type: "set", key: `k${index}`, value: 1 });
      if (!result.ok) throw new Error(`failed at ${index}`);
    }
    expect(await storageOp(root, "many", { type: "set", key: "one-more", value: 1 })).toEqual({ ok: false, error: "app storage holds at most 1000 keys" });
    expect((await storageOp(root, "many", { type: "set", key: "k5", value: 2 })).ok).toBe(true);
  }, 30_000);

  it("keeps prototype-looking keys as plain data", async () => {
    await storageOp(root, "proto", { type: "set", key: "__proto__", value: { polluted: true } });
    await storageOp(root, "proto", { type: "set", key: "constructor", value: 1 });
    expect(await storageOp(root, "proto", { type: "get", key: "__proto__" })).toMatchObject({ value: { polluted: true } });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(await storageOp(root, "proto", { type: "keys" })).toMatchObject({ keys: ["__proto__", "constructor"] });
  });

  it("does not lose concurrent writes", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, index) => storageOp(root, "race", { type: "set", key: `k${index}`, value: index })));
    const keys = await storageOp(root, "race", { type: "keys" });
    expect(keys.ok && keys.keys?.length).toBe(25);
  });

  it("refuses MCP app keys and hashes odd keys into a safe file name", async () => {
    expect(await storageOp(root, "mcp:server:ui://x", { type: "get", key: "a" })).toMatchObject({ ok: false });
    await storageOp(root, "../../escape", { type: "set", key: "a", value: 1 });
    const files = await readdir(appDataDir(root));
    expect(files).toEqual([`${appFileId("../../escape")}.json`]);
    expect(files[0]).toMatch(/^x-[0-9a-f]{24}\.json$/);
  });

  it("treats a corrupted file as empty instead of failing", async () => {
    await mkdir(path.join(root, "apps"), { recursive: true });
    await writeFile(path.join(root, "apps", "bad.json"), "{not json");
    expect(await storageOp(root, "bad", { type: "get", key: "a" })).toMatchObject({ ok: true, value: null });
    expect((await storageOp(root, "bad", { type: "set", key: "a", value: 1 })).ok).toBe(true);
  });
});

describe("approvals", () => {
  it("starts empty, records exact domain sets and always grants per html hash", async () => {
    expect(await approvalsOp(root, "app", { type: "get" })).toEqual({ connect: [], always: [] });
    await approvalsOp(root, "app", { type: "approveConnect", domains: ["https://b.example.com", "https://a.example.com"] });
    await approvalsOp(root, "app", { type: "approveConnect", domains: ["https://a.example.com", "https://b.example.com"] });
    await approvalsOp(root, "app", { type: "always", kind: "message", htmlHash: "abc" });
    await approvalsOp(root, "app", { type: "always", kind: "message", htmlHash: "abc" });
    const now = await approvalsOp(root, "app", { type: "get" });
    expect(now.connect).toEqual(["https://a.example.com https://b.example.com"]);
    expect(now.always).toEqual([{ kind: "message", htmlHash: "abc" }]);
    expect((await approvalsOp(root, "other", { type: "get" })).connect).toEqual([]);
  });

  it("ignores a malformed approvals file", async () => {
    await mkdir(path.join(root, "apps"), { recursive: true });
    await writeFile(path.join(root, "apps", "app.approvals.json"), JSON.stringify({ connect: "nope" }));
    expect(await approvalsOp(root, "app", { type: "get" })).toEqual({ connect: [], always: [] });
  });

  it("reset removes approvals of every agent but keeps saved state", async () => {
    const storageRoot = path.join(root, "agents");
    for (const agent of ["a1", "a2"]) {
      const dir = path.join(storageRoot, agent);
      await approvalsOp(dir, "app", { type: "approveConnect", domains: ["https://x.example.com"] });
      await storageOp(dir, "app", { type: "set", key: "k", value: 1 });
    }
    expect(await resetAllApprovals(storageRoot)).toBe(2);
    expect(await approvalsOp(path.join(storageRoot, "a1"), "app", { type: "get" })).toEqual({ connect: [], always: [] });
    expect(await storageOp(path.join(storageRoot, "a1"), "app", { type: "get", key: "k" })).toMatchObject({ value: 1 });
    expect(await resetAllApprovals(path.join(root, "missing"))).toBe(0);
  });
});

describe("downloads on the daemon", () => {
  it("writes into <storage>/downloads with a sanitised, non-clobbering name", async () => {
    const first = await saveDownload(root, { filename: "../../evil/../report.csv", mimeType: "text/csv", text: "a,b\n1,2" });
    expect(first.ok && first.path).toBe(path.join(root, "downloads", "report.csv"));
    expect(await readFile(path.join(root, "downloads", "report.csv"), "utf8")).toBe("a,b\n1,2");
    const second = await saveDownload(root, { filename: "report.csv", mimeType: "text/csv", text: "new" });
    expect(second.ok && path.basename(second.path)).toBe("report (2).csv");
    expect(await readFile(path.join(root, "downloads", "report.csv"), "utf8")).toBe("a,b\n1,2");
    const binary = await saveDownload(root, { filename: "x.bin", mimeType: "application/octet-stream", base64: Buffer.from([1, 2, 3, 255]).toString("base64") });
    expect(binary.ok && binary.bytes).toBe(4);
  });

  it("rejects oversize, bad base64, bad mime and ambiguous bodies", async () => {
    const big = "x".repeat(APP_LIMITS.downloadBytes + 1);
    expect(await saveDownload(root, { filename: "a", mimeType: "text/plain", text: big })).toMatchObject({ ok: false, error: "file is over 10 MB" });
    expect(await saveDownload(root, { filename: "a", mimeType: "text/plain", base64: "!!!" })).toMatchObject({ ok: false, error: "invalid base64" });
    expect(await saveDownload(root, { filename: "a", mimeType: "x", text: "a" })).toMatchObject({ ok: false, error: "invalid mime type" });
    expect(await saveDownload(root, { filename: "a", mimeType: "text/plain", text: "a", base64: "YQ==" })).toMatchObject({ ok: false });
    expect(await saveDownload(root, { filename: "a", mimeType: "text/plain" })).toMatchObject({ ok: false });
    expect(await readdir(path.join(root, "downloads")).catch(() => [])).toEqual([]);
  });

  it("never writes outside the downloads folder, even through a symlinked name", async () => {
    await mkdir(path.join(root, "downloads"), { recursive: true });
    await symlink("/etc/hostname", path.join(root, "downloads", "link.txt"));
    const result = await saveDownload(root, { filename: "link.txt", mimeType: "text/plain", text: "x" });
    expect(result.ok && path.basename(result.path)).toBe("link (2).txt");
  });
});

describe("paseo/load rules", () => {
  const agentId = `app-host-test-${process.pid}-${Date.now()}`;
  const storage = agentStorageDir(agentId);
  const paseo = { agents: { ref: () => ({ current: () => ({ cwd: null }), refresh: async () => null }) } } as never;

  afterAll(() => rm(storage, { recursive: true, force: true }));

  it("loads from thread storage with Load()'s parsing, and refuses the apps data folder", async () => {
    await mkdir(path.join(storage, "apps"), { recursive: true });
    await writeFile(path.join(storage, "data.json"), '{"a":[1,2]}');
    await writeFile(path.join(storage, "apps", "other.json"), '{"version":1,"entries":{"secret":1}}');
    expect(await loadForApp(paseo, agentId, "$BB_THREAD_STORAGE/data.json")).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(await loadForApp(paseo, agentId, path.join(storage, "data.json"))).toEqual({ ok: true, value: { a: [1, 2] } });
    for (const protectedPath of ["$BB_THREAD_STORAGE/apps/other.json", "$PASEO_THREAD_STORAGE/apps/other.json", path.join(storage, "apps", "other.json"), `$BB_THREAD_STORAGE/x/../apps/other.json`, "apps/other.json"]) {
      const refused = await loadForApp(paseo, agentId, protectedPath);
      expect(refused, protectedPath).toEqual({ ok: false, error: "app data cannot be loaded; use paseo.storage" });
    }
  });

  it("keeps Load()'s root rules: nothing outside the allowed folders, no symlink escapes", async () => {
    const outside = await mkdtemp(path.join(os.homedir(), "genui-outside-"));
    made.push(outside);
    await writeFile(path.join(outside, "secret.json"), '{"s":1}');
    expect(await loadForApp(paseo, agentId, path.join(outside, "secret.json"))).toMatchObject({ ok: false });
    expect(await loadForApp(paseo, agentId, "/etc/passwd")).toMatchObject({ ok: false });
    await symlink(path.join(outside, "secret.json"), path.join(storage, "escape.json"));
    expect(await loadForApp(paseo, agentId, "$BB_THREAD_STORAGE/escape.json")).toMatchObject({ ok: false });
    expect(await loadForApp(paseo, agentId, "$BB_THREAD_STORAGE/missing.json")).toMatchObject({ ok: false, error: "file not found" });
  });

  it("refuses control characters and empty paths", async () => {
    expect(await loadForApp(paseo, agentId, "")).toEqual({ ok: false, error: "invalid path" });
    expect(await loadForApp(paseo, agentId, "a\u0000b")).toEqual({ ok: false, error: "invalid path" });
  });
});

describe("paseo/ai plumbing", () => {
  it("runs Haiku headless with no tools, no MCP, no memory and one turn of JSON output", () => {
    const args = claudeArgs({ prompt: "x" });
    expect(args).toEqual(expect.arrayContaining(["-p", "--model", "haiku", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "json"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(args).not.toContain("x");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("adds the app's system text after the fixed system prompt, never instead of it", () => {
    const args = claudeArgs({ prompt: "x", system: "answer in French" });
    const system = args[args.indexOf("--system-prompt") + 1] ?? "";
    expect(system).toContain("You have no tools");
    expect(system).toContain("answer in French");
  });

  it("parses the result object and sums input tokens including cache", () => {
    const parsed = parseClaudeJson(JSON.stringify({ type: "result", is_error: false, result: "Red, blue", usage: { input_tokens: 2, cache_creation_input_tokens: 658, cache_read_input_tokens: 10, output_tokens: 11 } }));
    expect(parsed).toEqual({ ok: true, text: "Red, blue", usage: { inputTokens: 670, outputTokens: 11 } });
    expect(parseClaudeJson(JSON.stringify([{ type: "system" }, { type: "result", result: "ok", usage: {} }]))).toMatchObject({ ok: true, text: "ok" });
  });

  it("reports failures without leaking details", () => {
    expect(parseClaudeJson("not json")).toMatchObject({ ok: false });
    expect(parseClaudeJson(JSON.stringify({ type: "result", is_error: true, result: "secret stack trace" }))).toEqual({ ok: false, error: "the AI helper could not answer" });
    expect(parseClaudeJson("null")).toMatchObject({ ok: false });
  });

  it("limits each app to 20 calls an hour", () => {
    let now = 0;
    const limiter = new AiRateLimiter(20, () => now);
    for (let index = 0; index < 20; index++) expect(limiter.tryTake("a|app")).toBe(true);
    expect(limiter.tryTake("a|app")).toBe(false);
    expect(limiter.tryTake("a|other")).toBe(true);
    now += 3_599_000;
    expect(limiter.tryTake("a|app")).toBe(false);
    now += 2_000;
    expect(limiter.tryTake("a|app")).toBe(true);
  });
});

describe("rpc schemas", () => {
  it("accept good input and refuse oversize or malformed input", () => {
    expect(appStorageRpc.input.safeParse({ agentId: "a", appKey: "k", op: { type: "set", key: "k", value: { a: [1] } } }).success).toBe(true);
    expect(appStorageRpc.input.safeParse({ agentId: "a", appKey: "k", op: { type: "set", key: "k".repeat(201), value: 1 } }).success).toBe(false);
    expect(appStorageRpc.input.safeParse({ agentId: "a", appKey: "k", op: { type: "nuke" } }).success).toBe(false);
    expect(appApprovalsRpc.input.safeParse({ agentId: "a", appKey: "k", action: { type: "always", kind: "root", htmlHash: "x" } }).success).toBe(false);
    expect(appLoadRpc.input.safeParse({ agentId: "a", path: "x".repeat(1025) }).success).toBe(false);
    expect(appDownloadRpc.input.safeParse({ agentId: "a", filename: "f", mimeType: "text/plain", text: "x" }).success).toBe(true);
    expect(appAiRpc.input.safeParse({ agentId: "a", appKey: "k", prompt: "p", maxTokens: 2001 }).success).toBe(false);
    expect(appAiRpc.input.safeParse({ agentId: "a", appKey: "k", prompt: "p", maxTokens: 2000 }).success).toBe(true);
  });
});
