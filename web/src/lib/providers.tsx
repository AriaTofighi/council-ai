import * as React from "react";
import { cn } from "@/lib/utils";
import type { ProviderId, ReasoningEffort, RunStatus } from "@/types";

/**
 * Provider identity. Color classes are listed literally so Tailwind can see them;
 * the actual hues live in tokens.css (--provider-*).
 */
export const PROVIDERS: Record<
  ProviderId,
  { name: string; cli: string; glyph: string; text: string; bg: string }
> = {
  claude: {
    name: "Claude Code",
    cli: "claude",
    glyph: "C",
    text: "text-provider-claude",
    bg: "bg-provider-claude",
  },
  codex: {
    name: "Codex",
    cli: "codex",
    glyph: "X",
    text: "text-provider-codex",
    bg: "bg-provider-codex",
  },
  agy: {
    name: "Antigravity",
    cli: "agy",
    glyph: "A",
    text: "text-provider-agy",
    bg: "bg-provider-agy",
  },
};

export const PROVIDER_IDS: ProviderId[] = ["claude", "codex", "agy"];

export function providerMeta(id: string) {
  return PROVIDERS[id as ProviderId] ?? PROVIDERS.claude;
}

export const EFFORT_LEVELS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** A small monogram tile tinted with the provider's hue. */
export function ProviderMark({
  provider,
  size = "md",
  className,
}: {
  provider: string;
  size?: "xs" | "sm" | "md" | "lg";
  className?: string;
}) {
  const meta = providerMeta(provider);
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-grid shrink-0 place-items-center font-mono font-semibold leading-none",
        meta.text,
        size === "xs" && "w-3 text-[0.625rem]",
        size === "sm" && "w-3.5 text-[0.75rem]",
        size === "md" && "w-4 text-[0.875rem]",
        size === "lg" && "w-5 text-base",
        className,
      )}
    >
      {meta.glyph}
    </span>
  );
}

export type Tone = "neutral" | "signal" | "success" | "warning" | "danger";

export function runStatusTone(status: RunStatus | string): Tone {
  switch (status) {
    case "completed":
    case "ok":
    case "ready":
      return "success";
    case "running":
      return "signal";
    case "partial":
    case "interrupted":
    case "login_required":
    case "pending":
      return "warning";
    case "failed":
    case "cancelled":
    case "missing":
    default:
      return status === "cancelled" ? "neutral" : "danger";
  }
}

export function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

const DOT: Record<Tone, string> = {
  neutral: "bg-subtle-foreground",
  signal: "bg-signal",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/** Status dot; pulses when tone is "signal" (live). */
export function StatusDot({ tone, className }: { tone: Tone; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0", className)} aria-hidden>
      {tone === "signal" && (
        <span className={cn("absolute inset-0 rounded-full opacity-60 animate-ping", DOT[tone])} />
      )}
      <span className={cn("relative size-1.5 rounded-full", DOT[tone])} />
    </span>
  );
}
