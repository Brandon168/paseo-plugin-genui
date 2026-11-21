import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { APP_LIMITS } from "./app-util";

const agentIdSchema = z.string().min(1).max(128);
/** `paseo-app-id` slug, a content hash, or `mcp:<server>:<resource uri>`. */
export const appKeySchema = z.string().min(1).max(600);
export const storageKeySchema = z.string().min(1).max(APP_LIMITS.keyChars);
export const approvalKindSchema = z.enum(["message", "link", "ai"]);
export type ApprovalKind = z.infer<typeof approvalKindSchema>;

const failure = z.object({ ok: z.literal(false), error: z.string() });

export const approvalsSchema = z.object({
  /** `connectKey()` of every domain set the user approved for this app. */
  connect: z.array(z.string().max(4000)).max(50),
  /** "Always for this app", valid for the exact HTML (`htmlHash`) it was given for. */
  always: z.array(z.object({ kind: approvalKindSchema, htmlHash: z.string().min(1).max(64) })).max(30),
});
export type AppApprovals = z.infer<typeof approvalsSchema>;

export const appStorageRpc = defineRpc({
  name: "genui.app_storage",
  input: z.object({
    agentId: agentIdSchema,
    appKey: appKeySchema,
    op: z.discriminatedUnion("type", [
      z.object({ type: z.literal("get"), key: storageKeySchema }),
      z.object({ type: z.literal("set"), key: storageKeySchema, value: z.json() }),
      z.object({ type: z.literal("delete"), key: storageKeySchema }),
      z.object({ type: z.literal("keys") }),
    ]),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), value: z.json().nullable(), keys: z.array(z.string()).optional() }),
    failure,
  ]),
});

export const appApprovalsRpc = defineRpc({
  name: "genui.app_approvals",
  input: z.object({
    agentId: agentIdSchema,
    appKey: appKeySchema,
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("get") }),
      z.object({ type: z.literal("approveConnect"), domains: z.array(z.string().max(300)).min(1).max(20) }),
      z.object({ type: z.literal("always"), kind: approvalKindSchema, htmlHash: z.string().min(1).max(64) }),
    ]),
  }),
  output: approvalsSchema,
});

/** Forgets every stored approval of every app of every agent ("Reset app approvals"). */
export const appApprovalsResetRpc = defineRpc({
  name: "genui.app_approvals_reset",
  input: z.object({}),
  output: z.object({ removed: z.number() }),
});

/** `paseo/load`: the same roots and parsing as Load(), minus the apps data folder. */
export const appLoadRpc = defineRpc({
  name: "genui.app_load",
  input: z.object({ agentId: agentIdSchema, path: z.string().min(1).max(APP_LIMITS.pathChars) }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), value: z.json() }), failure]),
});

/** `paseo/download` on native: writes into `<thread storage>/downloads/`. */
export const appDownloadRpc = defineRpc({
  name: "genui.app_download",
  input: z.object({
    agentId: agentIdSchema,
    filename: z.string().min(1).max(300),
    mimeType: z.string().min(1).max(100),
    text: z.string().max(APP_LIMITS.downloadBytes).optional(),
    base64: z.string().max(Math.ceil((APP_LIMITS.downloadBytes * 4) / 3) + 8).optional(),
  }),
  output: z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), path: z.string(), bytes: z.number() }), failure]),
});

/** `paseo/ai`: Claude Haiku through the `claude` CLI, headless, no tools. */
export const appAiRpc = defineRpc({
  name: "genui.app_ai",
  input: z.object({
    agentId: agentIdSchema,
    appKey: appKeySchema,
    prompt: z.string().min(1).max(APP_LIMITS.aiPromptChars),
    system: z.string().max(APP_LIMITS.aiSystemChars).optional(),
    maxTokens: z.number().int().min(1).max(APP_LIMITS.aiMaxTokens).optional(),
  }),
  output: z.discriminatedUnion("ok", [
    z.object({
      ok: z.literal(true),
      text: z.string(),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }).optional(),
    }),
    failure,
  ]),
});
