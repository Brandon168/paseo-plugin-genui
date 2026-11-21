import type { AppApprovals, ApprovalKind } from "../../shared/app-rpc";
import {
  CDN_ALLOWLIST,
  connectKey,
  readConnectRequest,
  validateAppDomains,
  type ValidatedDomains,
} from "../../shared/app-util";
import type { AppMode } from "./host-context";

export interface PolicyInput {
  readonly mode: AppMode;
  readonly html: string;
  /** mcp: the resource's `_meta.ui.csp`. `frameDomains` and `baseUriDomains` are never read. */
  readonly csp?: { readonly connectDomains?: readonly string[]; readonly resourceDomains?: readonly string[] } | undefined;
  /** "Allow CDN libraries" (genui only). */
  readonly allowCdn: boolean;
  /** `connectKey()` of every domain set approved for this app (genui) or server (mcp). */
  readonly approvedConnect: readonly string[];
}

export interface AppPolicy {
  /** The hosts the page asked to reach, validated; `rejected` are the ones dropped. */
  readonly requested: ValidatedDomains;
  readonly requestedKey: string;
  /** Nothing requested, or this exact set was approved. */
  readonly approved: boolean;
  /** Hosts for scripts, styles, images, fonts and media. */
  readonly resourceDomains: readonly string[];
  /** Hosts for fetch/XHR/WebSocket: only an approved request, otherwise none. */
  readonly connectDomains: readonly string[];
}

/**
 * What an app may load and reach. genui pages get the CDN allowlist (when the setting is on) and
 * the `paseo-connect` meta hosts after approval; MCP views get exactly the resource's `_meta.ui.csp`
 * `resourceDomains` and, after approval, its `connectDomains`.
 */
export function resolvePolicy(input: PolicyInput): AppPolicy {
  const requested =
    input.mode === "genui"
      ? readConnectRequest(input.html)
      : validateAppDomains(input.csp?.connectDomains, ["https", "wss"]);
  const requestedKey = connectKey(requested.valid);
  const approved = requested.valid.length === 0 || input.approvedConnect.includes(requestedKey);
  const resourceDomains =
    input.mode === "genui"
      ? input.allowCdn
        ? [...CDN_ALLOWLIST]
        : []
      : [...validateAppDomains(input.csp?.resourceDomains, ["https"]).valid];
  return { requested, requestedKey, approved, resourceDomains, connectDomains: approved ? [...requested.valid] : [] };
}

/** "Always for this app" holds only for the exact HTML it was given for. */
export function isAlwaysApproved(approvals: AppApprovals, kind: ApprovalKind, htmlHash: string): boolean {
  return approvals.always.some((entry) => entry.kind === kind && entry.htmlHash === htmlHash);
}
