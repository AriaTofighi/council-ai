import { useEffect, useState } from "react";
import { RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Hint } from "@/components/ui/tooltip";
import { DEFAULT_LIMITS, type RunLimitsForm } from "@/lib/run-config";

export function RunSettings({
  limits,
  allowReadOnlyTools,
  disabled,
  onChangeLimits,
  onChangeAllowReadOnlyTools,
}: {
  limits: RunLimitsForm;
  allowReadOnlyTools: boolean;
  disabled?: boolean;
  onChangeLimits: (l: RunLimitsForm) => void;
  onChangeAllowReadOnlyTools: (v: boolean) => void;
}) {
  return (
    <Popover>
      <Hint label="Limits & tools">
        <PopoverTrigger asChild>
          <Button variant="ghost" size="icon-xs" aria-label="Limits and tools">
            <SlidersHorizontal className="size-3.5" />
          </Button>
        </PopoverTrigger>
      </Hint>
      <PopoverContent align="start" side="top" className="w-72 space-y-2.5">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium">Limits</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={disabled}
            onClick={() => onChangeLimits(DEFAULT_LIMITS)}
            className="-mr-1"
          >
            <RotateCcw /> Reset
          </Button>
        </div>
        <p className="text-[0.6875rem] leading-snug text-subtle-foreground">Leave a field empty for no limit.</p>
        <LimitField
          id="lim-lead"
          label="Lead calls"
          unit="×"
          value={limits.maxLeadCalls}
          disabled={disabled}
          onChange={(v) => onChangeLimits({ ...limits, maxLeadCalls: v })}
        />
        <LimitField
          id="lim-total"
          label="Total calls"
          unit="×"
          value={limits.maxTotalCalls}
          disabled={disabled}
          onChange={(v) => onChangeLimits({ ...limits, maxTotalCalls: v })}
        />
        <LimitField
          id="lim-call"
          label="Per-call timeout"
          unit="s"
          scale={1000}
          value={limits.perCallTimeoutMs}
          disabled={disabled}
          onChange={(v) => onChangeLimits({ ...limits, perCallTimeoutMs: v })}
        />
        <LimitField
          id="lim-hard"
          label="Hard deadline"
          unit="s"
          scale={1000}
          value={limits.hardDeadlineMs}
          disabled={disabled}
          onChange={(v) => onChangeLimits({ ...limits, hardDeadlineMs: v })}
        />
        <Separator />
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="sw-synth" className="font-normal text-muted-foreground">
            Reserve synthesis call
          </Label>
          <Switch
            id="sw-synth"
            checked={limits.reserveSynthesisCall}
            disabled={disabled}
            onCheckedChange={(v) => onChangeLimits({ ...limits, reserveSynthesisCall: v })}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor="sw-tools" className="font-normal text-muted-foreground">
            Read-only file tools
          </Label>
          <Switch
            id="sw-tools"
            checked={allowReadOnlyTools}
            disabled={disabled}
            onCheckedChange={onChangeAllowReadOnlyTools}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A free-form limit: any positive number, or empty for "no limit". `scale` converts the
 * shown unit to the stored one (seconds shown, milliseconds stored).
 */
function LimitField({
  id,
  label,
  unit,
  value,
  scale = 1,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  unit: string;
  value: number | null;
  scale?: number;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const shown = value === null ? "" : String(Math.round((value / scale) * 100) / 100);
  const [draft, setDraft] = useState(shown);
  // Follow outside changes (Reset, restored settings) without fighting the user's typing.
  useEffect(() => setDraft(shown), [shown]);

  const commit = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return onChange(null);
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) onChange(Math.round(n * scale));
  };
  const invalid = draft.trim() !== "" && !(Number(draft) > 0);

  return (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="relative w-24">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          placeholder="No limit"
          value={draft}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            commit(e.target.value);
          }}
          onBlur={() => setDraft(shown)}
          className="h-7 pr-6 text-right text-xs tabular placeholder:text-subtle-foreground"
        />
        {draft.trim() !== "" && (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.6875rem] text-subtle-foreground">
            {unit}
          </span>
        )}
      </div>
    </div>
  );
}
