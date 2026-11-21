import { APP_LIMITS } from "../../shared/app-util";
import type { ApprovalKind } from "../../shared/app-rpc";

export type ConsentDecision = "allow" | "always" | "cancel";
export type ConsentOutcome = "granted" | "denied" | "timeout" | "busy";

export interface ConsentRequest {
  readonly kind: ApprovalKind;
  /** One line: what the app wants to do. */
  readonly title: string;
  /** Exactly what will happen: the full message, the full URL, the prompt. */
  readonly detail: string;
}

export interface PendingConsent {
  readonly id: number;
  readonly request: ConsentRequest;
}

export interface ConsentGateOptions {
  /** True when this kind was approved for good for this exact HTML. */
  isAlways(kind: ApprovalKind): boolean;
  /** Persists "Always for this app". Failures are ignored: the grant still holds for this session. */
  persistAlways(kind: ApprovalKind): void;
  timeoutMs?: number;
  maxPending?: number;
}

export interface ConsentGate {
  readonly pending: readonly PendingConsent[];
  subscribe(listener: () => void): () => void;
  request(request: ConsentRequest): Promise<ConsentOutcome>;
  /** The user pressed a button on the banner. `allow` for AI holds for the rest of this app session. */
  decide(id: number, decision: ConsentDecision): void;
  /** Unmount: nothing is left waiting. */
  cancelAll(): void;
}

/**
 * Holds requests from a page until the user decides. The UI shows `pending[0]` as a banner on the
 * app card. A request not answered within two minutes times out; more than three waiting at once
 * are refused ("busy"), so a page cannot bury the user in banners. Closures, not `class` (Hermes).
 */
export function createConsentGate(options: ConsentGateOptions): ConsentGate {
  let nextId = 1;
  let queue: Array<{
    readonly id: number;
    readonly request: ConsentRequest;
    readonly resolve: (outcome: ConsentOutcome) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];
  const listeners = new Set<() => void>();
  const session = new Set<ApprovalKind>();
  let snapshot: readonly PendingConsent[] = [];

  function publish(): void {
    snapshot = queue.map(({ id, request }) => ({ id, request }));
    for (const listener of [...listeners]) listener();
  }

  function settle(id: number, outcome: ConsentOutcome): void {
    const entry = queue.find((item) => item.id === id);
    if (entry === undefined) return;
    queue = queue.filter((item) => item.id !== id);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    publish();
  }

  return {
    get pending() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request(request) {
      if (options.isAlways(request.kind) || session.has(request.kind)) return Promise.resolve("granted");
      if (queue.length >= (options.maxPending ?? APP_LIMITS.maxPendingConsents)) return Promise.resolve("busy");
      return new Promise<ConsentOutcome>((resolve) => {
        const id = nextId++;
        const timer = setTimeout(() => settle(id, "timeout"), options.timeoutMs ?? APP_LIMITS.consentTimeoutMs);
        queue.push({ id, request, resolve, timer });
        publish();
      });
    },
    decide(id, decision) {
      const entry = queue.find((item) => item.id === id);
      if (entry === undefined) return;
      if (decision === "always") {
        session.add(entry.request.kind);
        options.persistAlways(entry.request.kind);
      } else if (decision === "allow" && entry.request.kind === "ai") {
        session.add("ai");
      }
      settle(id, decision === "cancel" ? "denied" : "granted");
    },
    cancelAll() {
      for (const entry of [...queue]) settle(entry.id, "denied");
    },
  };
}
