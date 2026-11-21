import { z } from "zod";
import { APP_LIMITS, base64DecodedLength, isAcceptablePath, isValidMimeType, utf8ByteLength } from "../../shared/app-util";

// JSON-RPC 2.0 over postMessage, the MCP Apps (spec 2026-01-26) wire format.
// Everything a page sends is untrusted: parse with these schemas, never read it directly.

export const PROTOCOL_VERSION = "2026-01-26";

export const RPC_ERROR = {
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Implementation-defined: denied, rate limited, failed. */
  failed: -32000,
  notInitialized: -32002,
} as const;

const idSchema = z.union([z.string().max(128), z.number().finite()]);
export type RpcId = z.infer<typeof idSchema>;

const envelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema.optional(),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
});

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: idSchema,
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

export type ParsedMessage =
  | { readonly kind: "request"; readonly id: RpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "response"; readonly id: RpcId; readonly ok: boolean }
  /** Valid JSON-RPC framing was missing but the sender gave an id: answer with invalid request. */
  | { readonly kind: "invalid"; readonly id: RpcId | null }
  /** Not JSON-RPC at all (other frame traffic): ignore. */
  | { readonly kind: "ignore" };

export function parseMessage(raw: unknown): ParsedMessage {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { kind: "ignore" };
  const candidate = raw as { jsonrpc?: unknown; id?: unknown; method?: unknown };
  if (candidate.jsonrpc !== "2.0") return { kind: "ignore" };
  const envelope = envelopeSchema.safeParse(raw);
  if (envelope.success) {
    const { id, method, params } = envelope.data;
    return id === undefined ? { kind: "notification", method, params } : { kind: "request", id, method, params };
  }
  if (candidate.method === undefined) {
    const response = responseSchema.safeParse(raw);
    if (response.success) {
      return { kind: "response", id: response.data.id, ok: response.data.error === undefined };
    }
  }
  const id = idSchema.safeParse(candidate.id);
  return { kind: "invalid", id: id.success ? id.data : null };
}

export function resultMessage(id: RpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

export function errorMessage(id: RpcId | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message: message.slice(0, 500) } };
}

export function notificationMessage(method: string, params: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", method, params };
}

export interface RpcError extends Error {
  readonly code: number;
  readonly isRpcError: true;
}

export function rpcError(code: number, message: string): RpcError {
  return Object.assign(new Error(message), { code, isRpcError: true as const });
}

export function isRpcError(value: unknown): value is RpcError {
  return value instanceof Error && (value as { isRpcError?: unknown }).isRpcError === true;
}

export const displayModeSchema = z.enum(["inline", "fullscreen", "pip"]);
export type DisplayMode = z.infer<typeof displayModeSchema>;

// --- Params --------------------------------------------------------------------------------

export const initializeParamsSchema = z
  .object({
    protocolVersion: z.string().max(40).optional(),
    appCapabilities: z
      .object({ availableDisplayModes: z.array(z.string().max(20)).max(5).optional() })
      .passthrough()
      .optional(),
    appInfo: z.object({ name: z.string().max(100).optional(), version: z.string().max(40).optional() }).passthrough().optional(),
    clientInfo: z.object({ name: z.string().max(100).optional(), version: z.string().max(40).optional() }).passthrough().optional(),
  })
  .passthrough();

const textBlock = z.object({ type: z.literal("text"), text: z.string() }).passthrough();

/** `ui/message`: one text block (spec 2026-01-26) or a list of them (ext-apps SDK). Text only. */
export const messageParamsSchema = z
  .object({
    role: z.literal("user"),
    content: z.union([textBlock, z.array(textBlock).min(1).max(20)]),
  })
  .passthrough()
  .transform((params, context) => {
    const blocks = Array.isArray(params.content) ? params.content : [params.content];
    const text = blocks.map((block) => block.text).join("\n\n");
    if (text.trim() === "") {
      context.addIssue({ code: "custom", message: "message is empty" });
      return z.NEVER;
    }
    if (text.length > APP_LIMITS.messageChars) {
      context.addIssue({ code: "custom", message: `message is over ${APP_LIMITS.messageChars} characters` });
      return z.NEVER;
    }
    return { text };
  });

export const openLinkParamsSchema = z.object({ url: z.string().max(APP_LIMITS.urlChars) }).passthrough();

export const displayModeParamsSchema = z.object({ mode: displayModeSchema }).passthrough();

export const sizeChangedParamsSchema = z
  .object({ width: z.number().finite().optional(), height: z.number().finite().optional() })
  .passthrough();

export const logParamsSchema = z
  .object({ level: z.string().max(20).optional(), logger: z.string().max(100).optional(), data: z.unknown().optional() })
  .passthrough();

export const toolCallParamsSchema = z
  .object({
    name: z.string().min(1).max(200),
    arguments: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const readResourceParamsSchema = z.object({ uri: z.string().min(1).max(APP_LIMITS.urlChars) }).passthrough();

const storageKey = z.string().min(1).max(APP_LIMITS.keyChars);
export const storageGetParamsSchema = z.object({ key: storageKey }).passthrough();
export const storageSetParamsSchema = z
  .object({ key: storageKey, value: z.json() })
  .passthrough();
export const storageKeysParamsSchema = z.object({}).passthrough().optional();

export const loadParamsSchema = z
  .object({ path: z.string().refine(isAcceptablePath, "invalid path") })
  .passthrough();

export const downloadParamsSchema = z
  .object({
    filename: z.string().min(1).max(300),
    mimeType: z.string().refine(isValidMimeType, "invalid mime type"),
    text: z.string().optional(),
    base64: z.string().optional(),
  })
  .passthrough()
  .superRefine((file, context) => {
    if ((file.text === undefined) === (file.base64 === undefined)) {
      context.addIssue({ code: "custom", message: "send either text or base64" });
      return;
    }
    const bytes = file.text !== undefined ? utf8ByteLength(file.text) : base64DecodedLength(file.base64 ?? "");
    if (bytes === null) context.addIssue({ code: "custom", message: "invalid base64" });
    else if (bytes > APP_LIMITS.downloadBytes) context.addIssue({ code: "custom", message: "file is over 10 MB" });
  });

export const aiParamsSchema = z
  .object({
    prompt: z.string().min(1).max(APP_LIMITS.aiPromptChars),
    system: z.string().max(APP_LIMITS.aiSystemChars).optional(),
    maxTokens: z.number().int().min(1).max(APP_LIMITS.aiMaxTokens).optional(),
  })
  .passthrough();

/** First readable problem of a zod error, for the JSON-RPC message. */
export function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return "invalid params";
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`.slice(0, 200);
}
