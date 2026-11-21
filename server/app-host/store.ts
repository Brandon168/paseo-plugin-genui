import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { approvalsSchema, type AppApprovals, type ApprovalKind } from "../../shared/app-rpc";
import { APP_LIMITS, appFileId, connectKey, utf8ByteLength } from "../../shared/app-util";
import type { JsonValue } from "../../shared/json";

// Per-app saved state and approvals live in the agent's thread storage:
//   <thread storage>/apps/<id>.json              { version: 1, entries: { key: value } }
//   <thread storage>/apps/<id>.approvals.json    AppApprovals
// `<id>` is the app's slug, or a hash for any other key (see appFileId).

const MAX_KEYS = 1000;

export type StorageOp =
  | { readonly type: "get"; readonly key: string }
  | { readonly type: "set"; readonly key: string; readonly value: JsonValue }
  | { readonly type: "delete"; readonly key: string }
  | { readonly type: "keys" };

export type StorageResult =
  | { readonly ok: true; readonly value: JsonValue | null; readonly keys?: string[] }
  | { readonly ok: false; readonly error: string };

const queues = new Map<string, Promise<unknown>>();

/** Runs tasks on one file one after another so concurrent set/delete calls cannot lose updates. */
function serialize<T>(file: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(file) ?? Promise.resolve();
  const next = previous.then(task, task);
  const tail = next.catch(() => undefined);
  queues.set(file, tail);
  void tail.then(() => {
    if (queues.get(file) === tail) queues.delete(file);
  });
  return next;
}

export function appDataDir(storageDir: string): string {
  return path.join(storageDir, "apps");
}

function appFile(storageDir: string, appKey: string, suffix: string): string {
  return path.join(appDataDir(storageDir), `${appFileId(appKey)}${suffix}`);
}

async function readJsonFile(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function writeTextAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

function readEntries(raw: unknown): Map<string, JsonValue> {
  const entries = new Map<string, JsonValue>();
  if (typeof raw !== "object" || raw === null) return entries;
  const stored = (raw as { entries?: unknown }).entries;
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return entries;
  for (const [key, value] of Object.entries(stored)) entries.set(key, value as JsonValue);
  return entries;
}

function serializeEntries(entries: ReadonlyMap<string, JsonValue>): string {
  return JSON.stringify({ version: 1, entries: Object.fromEntries(entries) });
}

export function storageOp(storageDir: string, appKey: string, op: StorageOp): Promise<StorageResult> {
  if (appKey.startsWith("mcp:")) {
    return Promise.resolve({ ok: false, error: "saved state is only available to ```app pages" });
  }
  const file = appFile(storageDir, appKey, ".json");
  return serialize(file, async (): Promise<StorageResult> => {
    const entries = readEntries(await readJsonFile(file));
    if (op.type === "keys") return { ok: true, value: null, keys: [...entries.keys()].sort() };
    if (op.type === "get") return { ok: true, value: entries.get(op.key) ?? null };
    if (op.type === "delete") {
      if (entries.delete(op.key)) await writeTextAtomic(file, serializeEntries(entries));
      return { ok: true, value: null };
    }
    if (!entries.has(op.key) && entries.size >= MAX_KEYS) {
      return { ok: false, error: `app storage holds at most ${MAX_KEYS} keys` };
    }
    const next = new Map(entries);
    next.set(op.key, op.value);
    const text = serializeEntries(next);
    if (utf8ByteLength(text) > APP_LIMITS.storageBytes) {
      return { ok: false, error: "app storage is full (1 MB per app)" };
    }
    await writeTextAtomic(file, text);
    return { ok: true, value: null };
  });
}

export type ApprovalAction =
  | { readonly type: "get" }
  | { readonly type: "approveConnect"; readonly domains: readonly string[] }
  | { readonly type: "always"; readonly kind: ApprovalKind; readonly htmlHash: string };

const EMPTY: AppApprovals = { connect: [], always: [] };

export function approvalsOp(storageDir: string, appKey: string, action: ApprovalAction): Promise<AppApprovals> {
  const file = appFile(storageDir, appKey, ".approvals.json");
  return serialize(file, async () => {
    const parsed = approvalsSchema.safeParse(await readJsonFile(file));
    const current: AppApprovals = parsed.success ? parsed.data : EMPTY;
    if (action.type === "get") return current;
    let next: AppApprovals;
    if (action.type === "approveConnect") {
      const key = connectKey(action.domains);
      next = current.connect.includes(key) ? current : { ...current, connect: [...current.connect, key].slice(-50) };
    } else {
      const exists = current.always.some((entry) => entry.kind === action.kind && entry.htmlHash === action.htmlHash);
      next = exists
        ? current
        : { ...current, always: [...current.always, { kind: action.kind, htmlHash: action.htmlHash }].slice(-30) };
    }
    if (next !== current) await writeTextAtomic(file, JSON.stringify(next));
    return next;
  });
}

/** Deletes every `*.approvals.json` under `<root>/<agent>/apps/`. Returns how many files went. */
export async function resetAllApprovals(storageRoot: string): Promise<number> {
  let removed = 0;
  const agents = await readdir(storageRoot, { withFileTypes: true }).catch(() => []);
  for (const agent of agents) {
    if (!agent.isDirectory()) continue;
    const dir = path.join(storageRoot, agent.name, "apps");
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const name of files) {
      if (!name.endsWith(".approvals.json")) continue;
      const file = path.join(dir, name);
      await serialize(file, () => rm(file, { force: true }));
      removed++;
    }
  }
  return removed;
}
