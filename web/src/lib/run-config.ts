import type { ProviderCatalogEntry, ProviderId } from "@/types";

export interface RunLimitsForm {
  maxLeadCalls: number;
  maxTotalCalls: number;
  perCallTimeoutMs: number;
  hardDeadlineMs: number;
  reserveSynthesisCall: boolean;
}

export const DEFAULT_LIMITS: RunLimitsForm = {
  maxLeadCalls: 6,
  maxTotalCalls: 14,
  perCallTimeoutMs: 90_000,
  hardDeadlineMs: 240_000,
  reserveSynthesisCall: true,
};

/** Antigravity encodes thinking level in the model slug, so effort is locked. */
export function isEffortLocked(
  catalog: ProviderCatalogEntry[],
  providerId: ProviderId,
  model?: string,
): boolean {
  if (!model) return false;
  const found = catalog.find((p) => p.id === providerId)?.models.find((m) => m.id === model);
  if (found) return !found.supportsEffort;
  return providerId === "agy" && /-(low|medium|high|xhigh|max)$/i.test(model);
}

export function teammateLabel(provider: ProviderId, leadProvider: ProviderId, n: number): string {
  return provider === leadProvider ? `${provider} specialist #${n}` : `${provider} teammate #${n}`;
}
