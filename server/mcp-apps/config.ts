import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * MCP servers from OpenCode's `mcp` config map (`opencode.json`), read the way OpenCode reads
 * them: packages/core/src/v1/config/mcp.ts (local: command, cwd, environment, enabled, timeout;
 * remote: url, headers, enabled, oauth, timeout) at anomalyco/opencode commit fc7e4cf9, and the
 * `{env:NAME}` / `{file:PATH}` substitution of packages/opencode/src/config/variable.ts.
 *
 * Environment values and headers are secrets: nothing here may put them in an error or a log.
 */

export type McpTransport =
  | {
      readonly kind: "stdio";
      readonly command: readonly string[];
      readonly cwd: string | null;
      readonly environment: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

export interface McpServerSpec {
  /** The key under `mcp` in the config file. */
  readonly name: string;
  readonly transport: McpTransport;
  /** The config file that defined the entry. Diagnostics only. */
  readonly source: string;
}

export interface McpConfigSkip {
  readonly name: string;
  readonly source: string;
  readonly reason: string;
}

export interface McpConfigResult {
  readonly servers: readonly McpServerSpec[];
  readonly skipped: readonly McpConfigSkip[];
}

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Removes comments and trailing commas outside string literals, so JSONC config parses as JSON. */
export function stripJsonc(text: string): string {
  let withoutComments = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inString) {
      withoutComments += ch;
      if (ch === "\\") {
        withoutComments += text[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
    } else if (ch === '"') {
      inString = true;
      withoutComments += ch;
    } else if (ch === "/" && text[i + 1] === "/") {
      const newline = text.indexOf("\n", i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    } else {
      withoutComments += ch;
    }
  }

  let out = "";
  inString = false;
  for (let i = 0; i < withoutComments.length; i++) {
    const ch = withoutComments[i] ?? "";
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += withoutComments[i + 1] ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === ",") {
      let next = i + 1;
      while (next < withoutComments.length && /\s/.test(withoutComments[next] ?? "")) next++;
      const following = withoutComments[next];
      if (following === "}" || following === "]") continue;
    }
    out += ch;
  }
  return out;
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

export interface ExpandContext {
  readonly configDir: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * `{env:NAME}` becomes the variable (empty when unset); `{file:PATH}` becomes the file's text
 * without its final newline, a relative PATH resolved from the config directory.
 * Throws when a `{file:}` cannot be read; the message carries no path or value.
 */
export function expandConfigValue(value: string, context: ExpandContext): string {
  const withEnv = value.replace(/\{env:([^}]+)\}/g, (_match, name: string) => context.env[name] || "");
  return withEnv.replace(/\{file:([^}]+)\}/g, (_match, requested: string) => {
    const expanded = requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(2)) : requested;
    const target = path.isAbsolute(expanded) ? expanded : path.resolve(context.configDir, expanded);
    try {
      return readFileSync(target, "utf8").replace(/\r?\n$/, "");
    } catch {
      throw new Error("a {file:} reference could not be read");
    }
  });
}

type Built = { readonly ok: true; readonly spec: McpServerSpec } | { readonly ok: false; readonly reason: string };

function expandRecord(value: unknown, context: ExpandContext, label: string): Record<string, string> | string {
  if (value === undefined) return {};
  if (!isRecord(value) || !Object.values(value).every((item) => typeof item === "string")) {
    return `${label} must map names to strings`;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, expandConfigValue(item as string, context)]),
  );
}

function localTransport(entry: JsonRecord, context: ExpandContext): McpTransport | string {
  const command = entry.command;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part) => typeof part === "string" && part.length > 0)
  ) {
    return "command must be a non-empty list of strings";
  }
  const expanded = command.map((part) => expandConfigValue(part as string, context));
  if (expanded[0] === "") return "command has an empty executable";
  if (entry.cwd !== undefined && typeof entry.cwd !== "string") return "cwd must be a string";
  const cwd =
    typeof entry.cwd === "string"
      ? path.resolve(context.configDir, expandConfigValue(entry.cwd, context))
      : null;
  const environment = expandRecord(entry.environment, context, "environment");
  if (typeof environment === "string") return environment;
  return { kind: "stdio", command: expanded, cwd, environment };
}

function remoteTransport(entry: JsonRecord, context: ExpandContext): McpTransport | string {
  if (typeof entry.url !== "string") return "url must be a string";
  let url: URL;
  try {
    url = new URL(expandConfigValue(entry.url, context));
  } catch {
    return "url is not a valid URL";
  }
  const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure) return "url must be https (or http on localhost)";
  const headers = expandRecord(entry.headers, context, "headers");
  if (typeof headers === "string") return headers;
  return { kind: "http", url: url.toString(), headers };
}

function buildSpec(name: string, entry: unknown, source: string, context: ExpandContext): Built {
  if (!isRecord(entry)) return { ok: false, reason: "entry is not an object" };
  if (entry.enabled === false) return { ok: false, reason: "disabled" };
  try {
    const transport =
      entry.type === "local"
        ? localTransport(entry, context)
        : entry.type === "remote"
          ? remoteTransport(entry, context)
          : 'type must be "local" or "remote"';
    if (typeof transport === "string") return { ok: false, reason: transport };
    return { ok: true, spec: { name, transport, source } };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "entry could not be read" };
  }
}

/** Entry-level merge: later keys win; `environment` and `headers` maps merge key by key. */
function mergeEntries(base: unknown, next: unknown): unknown {
  if (!isRecord(base) || !isRecord(next)) return next;
  const merged: JsonRecord = { ...base, ...next };
  for (const key of ["environment", "headers"]) {
    const left = base[key];
    const right = next[key];
    if (isRecord(left) && isRecord(right)) merged[key] = { ...left, ...right };
  }
  return merged;
}

interface Candidate {
  readonly entry: unknown;
  readonly source: string;
  readonly configDir: string;
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Reads the `mcp` map of each config file. Files are given least specific first: a later file
 * overrides an earlier entry with the same name. Missing files are ignored.
 */
export async function loadMcpServers(
  files: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<McpConfigResult> {
  const candidates = new Map<string, Candidate>();
  const skipped: McpConfigSkip[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if (!isNotFound(error)) skipped.push({ name: "*", source: file, reason: "config file could not be read" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseJsonc(text);
    } catch {
      skipped.push({ name: "*", source: file, reason: "config file is not valid JSON" });
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.mcp)) continue;
    const configDir = path.dirname(file);
    for (const [name, entry] of Object.entries(parsed.mcp)) {
      const previous = candidates.get(name);
      candidates.set(name, {
        entry: mergeEntries(previous?.entry, entry),
        source: file,
        configDir,
      });
    }
  }

  const servers: McpServerSpec[] = [];
  for (const [name, candidate] of candidates) {
    const built = buildSpec(name, candidate.entry, candidate.source, {
      configDir: candidate.configDir,
      env,
    });
    if (built.ok) servers.push(built.spec);
    else skipped.push({ name, source: candidate.source, reason: built.reason });
  }
  servers.sort((left, right) => left.name.localeCompare(right.name));
  return { servers, skipped };
}

function opencodeConfigFilesIn(dir: string): string[] {
  return [path.join(dir, "opencode.json"), path.join(dir, "opencode.jsonc")];
}

/** The user's global OpenCode config, honouring XDG_CONFIG_HOME when it is absolute. */
export function globalOpencodeConfigFiles(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const configHome =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, ".config");
  return opencodeConfigFilesIn(path.join(configHome, "opencode"));
}

/** The OpenCode config in an agent's working directory. */
export function projectOpencodeConfigFiles(dir: string): string[] {
  return opencodeConfigFilesIn(dir);
}
