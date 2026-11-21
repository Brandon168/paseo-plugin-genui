import * as ui from "@getpaseo/plugin/client/ui";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ForwardRefExoticComponent,
  type RefAttributes,
} from "react";
import { View } from "react-native";
import { buildAppCsp } from "../../shared/app-util";
import { canRenderWebIframe, mountSandboxedAppIframe, type SandboxedIframe } from "../web";

// Slice A (Paseo core) adds `HtmlFrame` to the plugin SDK's client UI. Stock Paseo does not have it
// yet, so these are local copies of its documented API (docs/inline-apps/SPEC.md, section A) and the
// component is looked up at runtime. Without it: web keeps the sandboxed srcdoc iframe below,
// native shows the "open on desktop or web" message.

export interface HtmlFrameCsp {
  readonly resourceDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
}

export interface HtmlFrameHandle {
  postMessage(message: unknown): void;
}

export interface HtmlFrameProps {
  html: string;
  csp?: HtmlFrameCsp;
  autoHeight?: { min?: number; max?: number } | false;
  height?: number;
  fill?: boolean;
  scrollEnabled?: boolean;
  active?: boolean;
  onContentHeight?(height: number): void;
  onMessage?(message: unknown): void;
  onError?(message: string): void;
  onLoad?(): void;
  testID?: string;
}

type HtmlFrameComponent = ForwardRefExoticComponent<HtmlFrameProps & RefAttributes<HtmlFrameHandle>>;

/** Paseo's own `HtmlFrame`, when the running host has it. */
export function runtimeHtmlFrame(): HtmlFrameComponent | null {
  const candidate = (ui as unknown as { HtmlFrame?: HtmlFrameComponent }).HtmlFrame;
  return typeof candidate === "object" || typeof candidate === "function" ? (candidate ?? null) : null;
}

export type FrameSupport = "host" | "web-iframe" | "none";

export function frameSupport(): FrameSupport {
  if (runtimeHtmlFrame() !== null) return "host";
  return canRenderWebIframe() ? "web-iframe" : "none";
}

const DEFAULT_HEIGHT = 180;

/** The stock-Paseo web frame, with HtmlFrame's props and handle. */
const FallbackWebFrame = forwardRef<HtmlFrameHandle, HtmlFrameProps>(function FallbackWebFrame(props, ref) {
  const { html, csp, fill = false, active = true } = props;
  const containerRef = useRef<View | null>(null);
  const frameRef = useRef<SandboxedIframe | null>(null);
  const [height, setHeight] = useState(props.height ?? DEFAULT_HEIGHT);
  const latest = useRef(props);
  latest.current = props;
  const cspKey = JSON.stringify([csp?.resourceDomains ?? [], csp?.connectDomains ?? []]);

  useImperativeHandle(ref, () => ({ postMessage: (message) => frameRef.current?.post(message) }), []);

  useEffect(() => {
    if (!active || containerRef.current === null) return;
    const frame = mountSandboxedAppIframe(containerRef.current, {
      html,
      csp: buildAppCsp(csp),
      height,
      fill,
      onHeight: (measured) => {
        if (latest.current.autoHeight === false || fill) return;
        const min = latest.current.autoHeight?.min ?? 80;
        const max = latest.current.autoHeight?.max ?? 1400;
        const clamped = Math.min(max, Math.max(min, measured));
        setHeight(clamped);
        latest.current.onContentHeight?.(clamped);
      },
      onMessage: (message) => latest.current.onMessage?.(message),
      onError: (message) => latest.current.onError?.(message),
    });
    frameRef.current = frame;
    latest.current.onLoad?.();
    return () => {
      frameRef.current = null;
      frame.dispose();
    };
    // `height` is only the first size; later measures resize the iframe directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, cspKey, fill, active]);

  return (
    <View
      ref={containerRef}
      testID={props.testID}
      style={fill ? { flex: 1, width: "100%", minHeight: 0 } : { width: "100%", minHeight: height }}
    />
  );
});

/** Renders `html` in Paseo's HtmlFrame, or the stock web iframe, or nothing when neither exists. */
export const HostFrame = forwardRef<HtmlFrameHandle, HtmlFrameProps>(function HostFrame(props, ref) {
  const Runtime = runtimeHtmlFrame();
  if (Runtime !== null) return <Runtime ref={ref} {...props} />;
  if (canRenderWebIframe()) return <FallbackWebFrame ref={ref} {...props} />;
  return null;
});
