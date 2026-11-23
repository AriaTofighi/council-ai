import type { DelegationRunResult } from "../types/session.js";
import {
  runLeadDelegation,
  type RunOrchestratedTurnOptions,
} from "./loop.js";
import { runRoundtableTurn } from "./roundtable.js";

export async function runOrchestratedTurn(
  options: RunOrchestratedTurnOptions,
): Promise<DelegationRunResult> {
  if (options.mode === "roundtable") {
    return runRoundtableTurn(options);
  }
  return runLeadDelegation(options);
}

export {
  DEFAULT_RUN_LIMITS,
  adapterTimeout,
  effectiveRunLimits,
  resolveRunLimits,
  runLeadDelegation,
  synthesizeFromContributions,
  type PersistenceHooks,
  type RunLeadDelegationOptions,
  type RunOrchestratedTurnOptions,
  type SynthesisResult,
  type SynthesizeFromContributionsOptions,
} from "./loop.js";
export { runRoundtableTurn } from "./roundtable.js";
export {
  formatPriorConversationContext,
  formatWorkspaceSnapshotContext,
} from "./context.js";
export {
  LEAD_ACTION_JSON_SCHEMA,
  ROUNDTABLE_OPENING_SCHEMA,
  validateLeadAction,
  validateRoundtableOpeningPlan,
} from "./schemas.js";
