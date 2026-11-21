import path from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import {
  appAiRpc,
  appApprovalsResetRpc,
  appApprovalsRpc,
  appDownloadRpc,
  appLoadRpc,
  appStorageRpc,
} from "../../shared/app-rpc";
import { isAcceptablePath, isProtectedStoragePath } from "../../shared/app-util";
import { agentStorageDir, loadAgentFile } from "../data-source";
import { AiRateLimiter, runClaudeHaiku, type AiRunner } from "./ai";
import { saveDownload } from "./download";
import type { JsonValue } from "../../shared/json";
import { approvalsOp, resetAllApprovals, storageOp } from "./store";

type PaseoApi = PluginHandlerContext["paseo"];

/** `paseo/load`: Load()'s roots and parsing, but never another app's saved state or approvals. */
export async function loadForApp(
  paseo: PaseoApi,
  agentId: string,
  requested: string,
): Promise<{ ok: true; value: JsonValue } | { ok: false; error: string }> {
  if (!isAcceptablePath(requested)) return { ok: false, error: "invalid path" };
  if (isProtectedStoragePath(requested, agentStorageDir(agentId))) {
    return { ok: false, error: "app data cannot be loaded; use paseo.storage" };
  }
  const loaded = await loadAgentFile(paseo, agentId, requested, {});
  return loaded.ok ? { ok: true, value: loaded.value as JsonValue } : { ok: false, error: loaded.error };
}

export interface AppHostOptions {
  /** Whether "Allow apps to call AI" is on. */
  readonly aiEnabled: () => Promise<boolean>;
  readonly runAi?: AiRunner;
  readonly aiLimiter?: AiRateLimiter;
}

export function registerAppHost(server: PluginServerContext, options: AppHostOptions): void {
  const runAi = options.runAi ?? runClaudeHaiku;
  const limiter = options.aiLimiter ?? new AiRateLimiter();

  server.handle(appStorageRpc, ({ agentId, appKey, op }) => storageOp(agentStorageDir(agentId), appKey, op));
  server.handle(appApprovalsRpc, ({ agentId, appKey, action }) =>
    approvalsOp(agentStorageDir(agentId), appKey, action),
  );
  server.handle(appApprovalsResetRpc, async () => ({
    removed: await resetAllApprovals(path.dirname(agentStorageDir("x"))),
  }));
  server.handle(appLoadRpc, ({ agentId, path: requested }, { paseo }) => loadForApp(paseo, agentId, requested));
  server.handle(appDownloadRpc, ({ agentId, ...file }) => saveDownload(agentStorageDir(agentId), file));
  server.handle(appAiRpc, async ({ agentId, appKey, prompt, system, maxTokens }) => {
    if (!(await options.aiEnabled())) return { ok: false as const, error: "apps are not allowed to call AI (Generative UI settings)" };
    if (!limiter.tryTake(`${agentId}\n${appKey}`)) {
      return { ok: false as const, error: "AI limit reached for this app (20 calls per hour)" };
    }
    const result = await runAi({ prompt, system, maxTokens });
    if (result.ok) console.debug(`[genui] paseo/ai input_tokens=${result.usage?.inputTokens ?? "?"} output_tokens=${result.usage?.outputTokens ?? "?"}`);
    return result;
  });
}
