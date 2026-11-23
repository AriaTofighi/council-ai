import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Hint } from "@/components/ui/tooltip";
import { PROVIDER_IDS, ProviderMark } from "@/lib/providers";
import { modelEfforts } from "@/lib/run-config";
import type { ParticipantSpec, ProviderCatalogEntry, ProviderId } from "@/types";
import { EffortScale } from "./EffortScale";

const DEFAULT_MODEL = "__default";

export function ParticipantEditor({
  participant,
  catalog,
  disabled,
  role,
  onChange,
  onProviderChange,
  onRemove,
}: {
  participant: ParticipantSpec;
  catalog: ProviderCatalogEntry[];
  disabled?: boolean;
  role: "lead" | "teammate";
  onChange: (patch: Partial<ParticipantSpec>) => void;
  onProviderChange: (provider: ProviderId) => void;
  onRemove?: () => void;
}) {
  const models = catalog.find((p) => p.id === participant.provider)?.models ?? [];
  const levels = modelEfforts(catalog, participant.provider, participant.model);
  const locked = levels.length === 0;

  return (
    <div className="group/p space-y-2 rounded-md border bg-card p-2.5">
      <div className="flex items-center gap-2">
        <Select value={participant.provider} disabled={disabled} onValueChange={(v) => onProviderChange(v as ProviderId)}>
          <SelectTrigger size="sm" aria-label="Provider" className="h-7 w-auto gap-1.5 border-transparent px-1.5 shadow-none hover:bg-accent">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_IDS.map((id) => (
              <SelectItem key={id} value={id}>
                <span className="flex items-center gap-2">
                  <ProviderMark provider={id} size="xs" />
                  {id}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {role === "teammate" ? (
          <Input
            value={participant.label}
            disabled={disabled}
            aria-label="Name"
            onChange={(e) => onChange({ label: e.target.value })}
            className="h-7 min-w-0 flex-1 border-transparent bg-transparent px-1.5 text-[0.8125rem] shadow-none hover:border-input"
          />
        ) : (
          <span className="flex-1 px-1.5 text-[0.8125rem] text-muted-foreground">{participant.label}</span>
        )}
        {onRemove && (
          <Hint label="Remove">
            <button
              type="button"
              disabled={disabled}
              onClick={onRemove}
              aria-label={`Remove ${participant.label}`}
              className="grid size-6 place-items-center rounded text-subtle-foreground opacity-0 outline-none transition-opacity hover:text-danger focus-visible:opacity-100 group-hover/p:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          </Hint>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Select
          value={participant.model ?? DEFAULT_MODEL}
          disabled={disabled}
          onValueChange={(v) => {
            const model = v === DEFAULT_MODEL ? undefined : v;
            // Keep the current thinking level only if the new model accepts it.
            const next = modelEfforts(catalog, participant.provider, model);
            const effort = participant.effort && next.includes(participant.effort) ? participant.effort : undefined;
            onChange({ model, effort });
          }}
        >
          <SelectTrigger size="sm" aria-label="Model" className="h-7 min-w-0 flex-1 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_MODEL}>Default model</SelectItem>
            {models.map((m) => (
              <SelectItem key={m.id} value={m.id} hint={m.isFast ? "fast" : undefined}>
                {m.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <EffortScale
          value={locked ? undefined : participant.effort}
          disabled={disabled}
          levels={levels}
          lockedReason={locked ? "This model has no thinking levels" : undefined}
          onChange={(effort) => onChange({ effort })}
        />
      </div>
    </div>
  );
}
