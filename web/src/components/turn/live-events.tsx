import type { ReactNode } from "react";
import {
  ArrowRightLeft,
  BookOpen,
  CheckCircle2,
  CircleDot,
  Flag,
  MessageCircle,
  Play,
  Send,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import type { Tone } from "@/lib/providers";
import type { StoredRunEvent } from "@/types";

export interface LiveEventView {
  icon: ReactNode;
  text: string;
  tone: Tone;
}

/** Turns a raw SSE run event into one human sentence for the live feed. */
export function describeLiveEvent(evt: StoredRunEvent): LiveEventView {
  const e = evt.event;
  switch (e.type) {
    case "run_started":
      return {
        icon: <Play />,
        tone: "neutral",
        text: `Convened ${e.mode === "roundtable" ? "roundtable" : "divide & conquer"} with ${
          Array.isArray(e.teammates) ? e.teammates.length : 0
        } teammate(s)`,
      };
    case "roundtable_opening_planned":
      return { icon: <Flag />, tone: "neutral", text: "Lead chose who opens the roundtable" };
    case "roundtable_turn_started":
      return {
        icon: <MessageCircle />,
        tone: "signal",
        text: `Round ${String(e.round)} · ${String(e.participantLabel)} ${e.isBlind ? "drafting a blind opening" : "responding"}`,
      };
    case "roundtable_turn_completed":
      return { icon: <CheckCircle2 />, tone: "success", text: `Round ${String(e.round)} complete` };
    case "lead_thinking":
      return {
        icon: <Sparkles />,
        tone: "signal",
        text: `Lead ${String(e.provider)} thinking${e.mustFinish ? " — final synthesis" : ` (step ${String(e.turn)})`}`,
      };
    case "lead_action": {
      const action = e.action as { action?: string } | undefined;
      return {
        icon: <CircleDot />,
        tone: "neutral",
        text: `Lead decided: ${(action?.action ?? "unknown").replace(/_/g, " ")}`,
      };
    }
    case "assignment_started": {
      const a = e.assignment as { participantLabel?: string; title?: string } | undefined;
      return { icon: <Send />, tone: "signal", text: `${a?.participantLabel ?? "Teammate"} → “${a?.title ?? ""}”` };
    }
    case "assignment_completed": {
      const c = e.contribution as { id?: string; participantLabel?: string; outcome?: string } | undefined;
      const ok = c?.outcome === "ok";
      return {
        icon: ok ? <CheckCircle2 /> : <TriangleAlert />,
        tone: ok ? "success" : "danger",
        text: `${c?.participantLabel ?? "Teammate"} replied ${c?.id ? `[${c.id}]` : ""}${ok ? "" : ` (${c?.outcome})`}`,
      };
    }
    case "followup_started":
      return { icon: <ArrowRightLeft />, tone: "signal", text: `Follow-up to ${String(e.participantId)}` };
    case "followup_completed": {
      const c = e.contribution as { id?: string; outcome?: string } | undefined;
      return { icon: <CheckCircle2 />, tone: "success", text: `Follow-up answered [${c?.id ?? "?"}]` };
    }
    case "contribution_retrieved":
      return { icon: <BookOpen />, tone: "neutral", text: `Lead re-read ${String(e.contributionId)} verbatim` };
    case "session_fallback":
      return {
        icon: <TriangleAlert />,
        tone: "warning",
        text: `Fallback for ${String(e.participantId)}: ${String(e.reason)}`,
      };
    case "diagnostic":
      return { icon: <TriangleAlert />, tone: "warning", text: String(e.message ?? "Diagnostic") };
    case "run_finished":
      return { icon: <Flag />, tone: "success", text: `Finished · ${String(e.status)}` };
    default:
      return { icon: <CircleDot />, tone: "neutral", text: e.type.replace(/_/g, " ") };
  }
}
