import type { ParticipantSpec, ProviderCatalogEntry, ProviderId, ReasoningEffort } from "@/types";

/** Run budget as edited in the UI. `null` = no limit. */
export interface RunLimitsForm {
  maxLeadCalls: number | null;
  maxTotalCalls: number | null;
  perCallTimeoutMs: number | null;
  hardDeadlineMs: number | null;
  reserveSynthesisCall: boolean;
}

export const DEFAULT_LIMITS: RunLimitsForm = {
  maxLeadCalls: 6,
  maxTotalCalls: 14,
  perCallTimeoutMs: 90_000,
  hardDeadlineMs: 240_000,
  reserveSynthesisCall: true,
};

const ALL_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const TIERED_SLUG_RE = /^(.+)-(low|medium|high|xhigh|max)$/i;

/** Thinking levels the CLI accepts for this model. Unknown or default model: all levels. */
export function modelEfforts(
  catalog: ProviderCatalogEntry[],
  providerId: ProviderId,
  model?: string,
): ReasoningEffort[] {
  if (!model) return ALL_EFFORTS;
  const models = catalog.find((p) => p.id === providerId)?.models;
  const found = models?.find((m) => m.id === model);
  if (found) return found.efforts ?? ALL_EFFORTS;
  return providerId === "agy" && TIERED_SLUG_RE.test(model) ? [] : ALL_EFFORTS;
}

/**
 * Makes a participant's model/effort pair valid for the current catalog: maps old agy
 * per-level slugs (gemini-4-neon-high) to family + effort, drops efforts the model doesn't
 * accept, and falls back to the CLI default when a model no longer exists.
 */
export function normalizeParticipant<T extends ParticipantSpec>(spec: T, catalog: ProviderCatalogEntry[]): T {
  const models = catalog.find((p) => p.id === spec.provider)?.models;
  if (!spec.model || !models || models.length === 0) return spec;
  let model: string | undefined = spec.model;
  let effort = spec.effort;
  let found = models.find((m) => m.id === model);
  if (!found && spec.provider === "agy") {
    const tier = TIERED_SLUG_RE.exec(model);
    const family = tier ? models.find((m) => m.id === tier[1]) : undefined;
    if (tier && family) {
      found = family;
      model = family.id;
      effort = tier[2]!.toLowerCase() as ReasoningEffort;
    }
  }
  if (!found) {
    model = undefined;
  } else if (effort && !found.efforts.includes(effort)) {
    effort = undefined;
  }
  if (model === spec.model && effort === spec.effort) return spec;
  return { ...spec, model, effort };
}

export function teammateLabel(provider: ProviderId, leadProvider: ProviderId, n: number): string {
  return provider === leadProvider ? `${provider} specialist #${n}` : `${provider} teammate #${n}`;
}
