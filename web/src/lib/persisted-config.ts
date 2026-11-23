import type { OrchestrationMode, ParticipantSpec } from "@/types";
import { DEFAULT_LIMITS, type RunLimitsForm } from "./run-config";

const CONFIG_KEY = "council.config.v1";

/** The last-used run configuration, restored when the site is reopened. */
export interface PersistedConfig {
  lead: ParticipantSpec;
  teammates: ParticipantSpec[];
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  allowReadOnlyTools: boolean;
  limits: RunLimitsForm;
  workspacePath: string;
  selectedPaths: string[];
}

export const DEFAULT_CONFIG: PersistedConfig = {
  lead: { provider: "claude", label: "claude lead" },
  teammates: [
    { id: "init_codex", provider: "codex", label: "codex teammate #1" },
    { id: "init_agy", provider: "agy", label: "agy teammate #1" },
  ],
  mode: "roundtable",
  independentFirstOpinions: false,
  allowReadOnlyTools: true,
  limits: DEFAULT_LIMITS,
  workspacePath: "",
  selectedPaths: [],
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isParticipant = (v: unknown): v is ParticipantSpec => isObject(v) && typeof v.provider === "string";

const limitOrNone = (v: unknown, fallback: number | null): number | null =>
  v === undefined ? fallback : typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

function readLimits(raw: Record<string, unknown>): RunLimitsForm {
  const d = DEFAULT_LIMITS;
  return {
    maxLeadCalls: limitOrNone(raw.maxLeadCalls, d.maxLeadCalls),
    maxTotalCalls: limitOrNone(raw.maxTotalCalls, d.maxTotalCalls),
    perCallTimeoutMs: limitOrNone(raw.perCallTimeoutMs, d.perCallTimeoutMs),
    hardDeadlineMs: limitOrNone(raw.hardDeadlineMs, d.hardDeadlineMs),
    reserveSynthesisCall:
      typeof raw.reserveSynthesisCall === "boolean" ? raw.reserveSynthesisCall : d.reserveSynthesisCall,
  };
}

/** Reads the saved config, falling back field-by-field to defaults for anything missing or malformed. */
export function loadConfig(): PersistedConfig {
  let raw: unknown;
  try {
    const text = localStorage.getItem(CONFIG_KEY);
    raw = text ? JSON.parse(text) : null;
  } catch {
    raw = null;
  }
  if (!isObject(raw)) return DEFAULT_CONFIG;
  const d = DEFAULT_CONFIG;
  return {
    lead: isParticipant(raw.lead) ? raw.lead : d.lead,
    teammates: Array.isArray(raw.teammates) ? raw.teammates.filter(isParticipant) : d.teammates,
    mode: typeof raw.mode === "string" ? (raw.mode as OrchestrationMode) : d.mode,
    independentFirstOpinions:
      typeof raw.independentFirstOpinions === "boolean" ? raw.independentFirstOpinions : d.independentFirstOpinions,
    allowReadOnlyTools: typeof raw.allowReadOnlyTools === "boolean" ? raw.allowReadOnlyTools : d.allowReadOnlyTools,
    limits: isObject(raw.limits) ? readLimits(raw.limits) : d.limits,
    workspacePath: typeof raw.workspacePath === "string" ? raw.workspacePath : d.workspacePath,
    selectedPaths: Array.isArray(raw.selectedPaths)
      ? raw.selectedPaths.filter((p): p is string => typeof p === "string")
      : d.selectedPaths,
  };
}

export function saveConfig(config: PersistedConfig): void {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    // Storage unavailable (private mode, quota) — config just won't persist.
  }
}
