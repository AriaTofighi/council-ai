import React, { useState } from "react";
import type {
  OrchestrationMode,
  ParticipantSpec,
  ProviderCatalogEntry,
  ProviderId,
  ReasoningEffort,
} from "../types";

export interface RunLimitsForm {
  maxLeadCalls: number;
  maxTotalCalls: number;
  perCallTimeoutMs: number;
  hardDeadlineMs: number;
  reserveSynthesisCall: boolean;
}

interface ControlBarProps {
  lead: ParticipantSpec;
  teammates: ParticipantSpec[];
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  allowReadOnlyTools: boolean;
  limits: RunLimitsForm;
  providers: ProviderCatalogEntry[];
  disabled?: boolean;
  onChangeLead: (next: ParticipantSpec) => void;
  onChangeTeammates: (next: ParticipantSpec[]) => void;
  onChangeMode: (next: OrchestrationMode) => void;
  onChangeIndependentFirstOpinions: (next: boolean) => void;
  onChangeAllowReadOnlyTools: (next: boolean) => void;
  onChangeLimits: (next: RunLimitsForm) => void;
  onApplyFastPreset: () => void;
}

const EFFORT_OPTIONS: Array<{ value: "" | ReasoningEffort; label: string }> = [
  { value: "", label: "CLI default" },
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

export const ControlBar: React.FC<ControlBarProps> = ({
  lead,
  teammates,
  mode,
  independentFirstOpinions,
  allowReadOnlyTools,
  limits,
  providers,
  disabled,
  onChangeLead,
  onChangeTeammates,
  onChangeMode,
  onChangeIndependentFirstOpinions,
  onChangeAllowReadOnlyTools,
  onChangeLimits,
  onApplyFastPreset,
}) => {
  const [showLimits, setShowLimits] = useState(false);
  const [addProvider, setAddProvider] = useState<ProviderId>("codex");

  const catalogById = new Map(providers.map((p) => [p.id, p]));

  const getModels = (providerId: ProviderId) =>
    catalogById.get(providerId)?.models ?? [];

  const isEffortDisabled = (providerId: ProviderId, model?: string) => {
    if (!model) return false;
    const found = getModels(providerId).find((m) => m.id === model);
    if (found) return !found.supportsEffort;
    return providerId === "agy" && /-(low|medium|high|xhigh|max)$/i.test(model);
  };

  const handleAddTeammate = () => {
    const countSame =
      teammates.filter((t) => t.provider === addProvider).length +
      (lead.provider === addProvider ? 1 : 0) +
      1;
    const label =
      addProvider === lead.provider
        ? `${addProvider} specialist #${countSame}`
        : `${addProvider} teammate #${countSame}`;
    onChangeTeammates([
      ...teammates,
      {
        id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        provider: addProvider,
        label,
      },
    ]);
  };

  const updateTeammate = (idx: number, patch: Partial<ParticipantSpec>) => {
    onChangeTeammates(
      teammates.map((t, i) => (i === idx ? { ...t, ...patch } : t)),
    );
  };

  const removeTeammate = (idx: number) => {
    onChangeTeammates(teammates.filter((_, i) => i !== idx));
  };

  return (
    <div className="control-bar">
      <div className="control-row">
        <div className="control-group control-lead">
          <div className="control-heading">
            <span>Lead</span>
            <button
              type="button"
              className="btn btn-xs btn-accent"
              disabled={disabled}
              onClick={onApplyFastPreset}
              title="Switch all participants to lower-usage models and low thinking effort for testing"
            >
              Low-usage preset
            </button>
          </div>
          <div className="control-inputs">
            <select
              aria-label="Lead provider"
              disabled={disabled}
              value={lead.provider}
              onChange={(e) => {
                const nextProvider = e.target.value as ProviderId;
                onChangeLead({
                  ...lead,
                  provider: nextProvider,
                  label: `${nextProvider} lead`,
                  model: undefined,
                  effort: lead.effort,
                });
              }}
            >
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="agy">agy</option>
            </select>

            <select
              aria-label="Lead model"
              disabled={disabled}
              value={lead.model ?? ""}
              onChange={(e) =>
                onChangeLead({
                  ...lead,
                  model: e.target.value || undefined,
                })
              }
            >
              <option value="">Default model</option>
              {getModels(lead.provider).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                  {m.isFast ? " (fast)" : ""}
                </option>
              ))}
            </select>

            <select
              aria-label="Lead thinking effort"
              disabled={disabled || isEffortDisabled(lead.provider, lead.model)}
              value={
                isEffortDisabled(lead.provider, lead.model)
                  ? ""
                  : lead.effort ?? ""
              }
              title={
                isEffortDisabled(lead.provider, lead.model)
                  ? "Thinking level is encoded in the selected Antigravity model slug"
                  : "Thinking / reasoning effort level"
              }
              onChange={(e) =>
                onChangeLead({
                  ...lead,
                  effort: (e.target.value || undefined) as
                    | ReasoningEffort
                    | undefined,
                })
              }
            >
              {EFFORT_OPTIONS.map((opt) => (
                <option key={opt.value || "default"} value={opt.value}>
                  Effort: {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="control-group control-mode">
          <div className="control-heading">
            <span>Mode</span>
            <button
              type="button"
              className="btn btn-xs btn-ghost"
              onClick={() => setShowLimits((v) => !v)}
            >
              {showLimits ? "Hide limits" : "Limits & tools"}
            </button>
          </div>
          <div className="mode-controls">
            <div className="segmented">
              <button
                type="button"
                className={mode === "divide_conquer" ? "active" : ""}
                disabled={disabled}
                onClick={() => onChangeMode("divide_conquer")}
              >
                Divide &amp; conquer
              </button>
              <button
                type="button"
                className={mode === "roundtable" ? "active" : ""}
                disabled={disabled}
                onClick={() => onChangeMode("roundtable")}
              >
                Roundtable
              </button>
            </div>
            {mode === "roundtable" && (
              <label className="checkbox-inline">
                <input
                  type="checkbox"
                  disabled={disabled}
                  checked={independentFirstOpinions}
                  onChange={(e) =>
                    onChangeIndependentFirstOpinions(e.target.checked)
                  }
                />
                <span>Independent first opinions</span>
              </label>
            )}
          </div>
        </div>
      </div>

      <div className="control-team-row">
        <div className="team-header">
          <span className="section-label">
            Team ({teammates.length} teammate{teammates.length === 1 ? "" : "s"})
          </span>
          <div className="add-teammate-box">
            <select
              aria-label="Add teammate provider"
              disabled={disabled}
              value={addProvider}
              onChange={(e) => setAddProvider(e.target.value as ProviderId)}
            >
              <option value="codex">codex</option>
              <option value="claude">claude</option>
              <option value="agy">agy</option>
            </select>
            <button
              type="button"
              className="btn btn-xs btn-secondary"
              disabled={disabled}
              onClick={handleAddTeammate}
            >
              + Add Teammate
            </button>
          </div>
        </div>

        <div className="team-chips">
          {teammates.length === 0 && (
            <span className="muted-hint">
              Solo lead mode — add teammates above to delegate or hold a roundtable.
            </span>
          )}
          {teammates.map((mate, idx) => {
            const effortLocked = isEffortDisabled(mate.provider, mate.model);
            return (
              <div key={mate.id ?? idx} className="teammate-chip">
                <select
                  aria-label={`Teammate ${idx + 1} provider`}
                  disabled={disabled}
                  value={mate.provider}
                  onChange={(e) => {
                    const nextP = e.target.value as ProviderId;
                    updateTeammate(idx, {
                      provider: nextP,
                      label:
                        nextP === lead.provider
                          ? `${nextP} specialist #${idx + 1}`
                          : `${nextP} teammate #${idx + 1}`,
                      model: undefined,
                    });
                  }}
                >
                  <option value="codex">codex</option>
                  <option value="claude">claude</option>
                  <option value="agy">agy</option>
                </select>

                <input
                  type="text"
                  className="chip-label-input"
                  disabled={disabled}
                  value={mate.label}
                  aria-label={`Teammate ${idx + 1} label`}
                  onChange={(e) =>
                    updateTeammate(idx, { label: e.target.value })
                  }
                />

                <select
                  aria-label={`Teammate ${idx + 1} model`}
                  disabled={disabled}
                  value={mate.model ?? ""}
                  onChange={(e) =>
                    updateTeammate(idx, {
                      model: e.target.value || undefined,
                    })
                  }
                >
                  <option value="">Default model</option>
                  {getModels(mate.provider).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                      {m.isFast ? " (fast)" : ""}
                    </option>
                  ))}
                </select>

                <select
                  aria-label={`Teammate ${idx + 1} effort`}
                  disabled={disabled || effortLocked}
                  value={effortLocked ? "" : mate.effort ?? ""}
                  onChange={(e) =>
                    updateTeammate(idx, {
                      effort: (e.target.value || undefined) as
                        | ReasoningEffort
                        | undefined,
                    })
                  }
                >
                  {EFFORT_OPTIONS.map((opt) => (
                    <option key={opt.value || "default"} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  className="chip-remove"
                  disabled={disabled}
                  title="Remove teammate"
                  onClick={() => removeTeammate(idx)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {showLimits && (
        <div className="limits-drawer">
          <label>
            <span>Max lead calls</span>
            <input
              type="number"
              min={1}
              max={20}
              disabled={disabled}
              value={limits.maxLeadCalls}
              onChange={(e) =>
                onChangeLimits({
                  ...limits,
                  maxLeadCalls: Number(e.target.value) || 1,
                })
              }
            />
          </label>
          <label>
            <span>Max total calls</span>
            <input
              type="number"
              min={1}
              max={40}
              disabled={disabled}
              value={limits.maxTotalCalls}
              onChange={(e) =>
                onChangeLimits({
                  ...limits,
                  maxTotalCalls: Number(e.target.value) || 1,
                })
              }
            />
          </label>
          <label>
            <span>Per-call timeout (s)</span>
            <input
              type="number"
              min={5}
              max={600}
              disabled={disabled}
              value={Math.round(limits.perCallTimeoutMs / 1000)}
              onChange={(e) =>
                onChangeLimits({
                  ...limits,
                  perCallTimeoutMs: (Number(e.target.value) || 60) * 1000,
                })
              }
            />
          </label>
          <label>
            <span>Hard deadline (s)</span>
            <input
              type="number"
              min={10}
              max={1800}
              disabled={disabled}
              value={Math.round(limits.hardDeadlineMs / 1000)}
              onChange={(e) =>
                onChangeLimits({
                  ...limits,
                  hardDeadlineMs: (Number(e.target.value) || 180) * 1000,
                })
              }
            />
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              disabled={disabled}
              checked={limits.reserveSynthesisCall}
              onChange={(e) =>
                onChangeLimits({
                  ...limits,
                  reserveSynthesisCall: e.target.checked,
                })
              }
            />
            <span>Reserve final synthesis call</span>
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              disabled={disabled}
              checked={allowReadOnlyTools}
              onChange={(e) => onChangeAllowReadOnlyTools(e.target.checked)}
            />
            <span>Allow read-only file tools</span>
          </label>
        </div>
      )}
    </div>
  );
};
