import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { APP_LIMITS } from "../../shared/app-util";

// `paseo/ai`: one Claude Haiku turn on the user's subscription, through the `claude` CLI.
//
// The flags keep the call small and inert (measured with `claude` 2.1.327):
//   -p                         headless, prompt on stdin
//   --model haiku              the cheapest model
//   --safe-mode                skips CLAUDE.md, memory, skills, plugins, hooks, MCP servers, agents
//                              (--bare would also skip them, but it refuses subscription login)
//   --tools ""                 no built-in tools, so a hostile prompt cannot act
//   --strict-mcp-config + an empty --mcp-config: no MCP servers from any other source
//   --disable-slash-commands   no skills or commands
//   --no-session-persistence   nothing saved to disk
//   --system-prompt            replaces Claude Code's long default prompt
//   --output-format json       one result object with token usage
// The process runs in an empty temp directory, with a minimal environment.

const SYSTEM_PROMPT =
  "You are a text helper inside a small web app. Answer the user's request directly and briefly. You have no tools and no access to files, the web or the user's data. Reply in plain text unless asked for another format.";

export interface AiRequest {
  readonly prompt: string;
  readonly system?: string | undefined;
  readonly maxTokens?: number | undefined;
}

export type AiResult =
  | { readonly ok: true; readonly text: string; readonly usage?: { inputTokens: number; outputTokens: number } }
  | { readonly ok: false; readonly error: string };

export interface AiRunner {
  (request: AiRequest, signal?: AbortSignal): Promise<AiResult>;
}

export function claudeArgs(request: AiRequest): string[] {
  const extra = request.system?.trim();
  const system = extra ? `${SYSTEM_PROMPT}\n\nThe app author asks: ${extra}` : SYSTEM_PROMPT;
  return [
    "-p",
    "--model",
    "haiku",
    "--safe-mode",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    system,
    "--output-format",
    "json",
  ];
}

function isExecutable(file: string): boolean {
  try {
    accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findClaudeBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.GENUI_CLAUDE_BIN;
  if (explicit && isExecutable(explicit)) return explicit;
  const candidates = [
    ...(env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "").map((dir) => path.join(dir, "claude")),
    path.join(os.homedir(), ".local", "bin", "claude"),
    path.join(os.homedir(), ".claude", "local", "claude"),
    "/usr/local/bin/claude",
  ];
  return candidates.find(isExecutable) ?? null;
}

/** Pulls the answer and token counts out of `claude -p --output-format json`. */
export function parseClaudeJson(stdout: string): AiResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, error: "the AI helper returned something unreadable" };
  }
  const result = Array.isArray(parsed)
    ? [...parsed].reverse().find((item) => typeof item === "object" && item !== null && (item as { type?: unknown }).type === "result")
    : parsed;
  if (typeof result !== "object" || result === null) return { ok: false, error: "the AI helper returned no result" };
  const record = result as {
    is_error?: unknown;
    result?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      cache_creation_input_tokens?: unknown;
      cache_read_input_tokens?: unknown;
    };
  };
  if (record.is_error === true || typeof record.result !== "string") {
    return { ok: false, error: "the AI helper could not answer" };
  }
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const usage = record.usage;
  const inputTokens = number(usage?.input_tokens) + number(usage?.cache_creation_input_tokens) + number(usage?.cache_read_input_tokens);
  return { ok: true, text: record.result, usage: { inputTokens, outputTokens: number(usage?.output_tokens) } };
}

let active = 0;
const MAX_CONCURRENT = 2;

export const runClaudeHaiku: AiRunner = async (request, signal) => {
  const binary = findClaudeBinary();
  if (binary === null) return { ok: false, error: "the claude CLI was not found on the daemon" };
  if (active >= MAX_CONCURRENT) return { ok: false, error: "the AI helper is busy, try again shortly" };
  active++;
  let cwd: string | null = null;
  try {
    cwd = await mkdtemp(path.join(os.tmpdir(), "genui-ai-"));
    const maxTokens = Math.min(request.maxTokens ?? APP_LIMITS.aiMaxTokens, APP_LIMITS.aiMaxTokens);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? os.homedir(),
      LANG: process.env.LANG ?? "C.UTF-8",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens),
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    return await new Promise<AiResult>((resolve) => {
      const child = spawn(binary, claudeArgs(request), { cwd: cwd ?? undefined, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let settled = false;
      const finish = (value: AiResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        child.kill("SIGKILL");
        resolve(value);
      };
      const onAbort = () => finish({ ok: false, error: "cancelled" });
      const timer = setTimeout(() => finish({ ok: false, error: "the AI helper took too long (60 s)" }), APP_LIMITS.aiTimeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 1_000_000) finish({ ok: false, error: "the AI helper returned too much" });
      });
      child.stderr.on("data", () => undefined);
      child.on("error", () => finish({ ok: false, error: "could not start the claude CLI" }));
      child.on("close", (code) => {
        if (code !== 0 && stdout.trim() === "") finish({ ok: false, error: `the AI helper failed (exit ${code ?? "?"})` });
        else finish(parseClaudeJson(stdout));
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(request.prompt);
    });
  } finally {
    active--;
    if (cwd !== null) await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
};

/** At most `limit` calls per app per rolling hour. */
export class AiRateLimiter {
  private readonly calls = new Map<string, number[]>();
  constructor(
    private readonly limit = APP_LIMITS.aiCallsPerHour,
    private readonly now: () => number = Date.now,
  ) {}

  tryTake(key: string): boolean {
    const cutoff = this.now() - 3_600_000;
    const recent = (this.calls.get(key) ?? []).filter((at) => at > cutoff);
    if (recent.length >= this.limit) {
      this.calls.set(key, recent);
      return false;
    }
    recent.push(this.now());
    this.calls.set(key, recent);
    return true;
  }
}
