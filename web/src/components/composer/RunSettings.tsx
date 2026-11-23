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
  const numberField = (
    id: string,
    label: string,
    value: number,
    unit: string,
    min: number,
    max: number,
    apply: (n: number) => RunLimitsForm,
  ) => (
    <div className="flex items-center justify-between gap-3">
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {label}
      </Label>
      <div className="relative w-20">
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n) && n > 0) onChangeLimits(apply(Math.min(max, n)));
          }}
          onBlur={() => value < min && onChangeLimits(apply(min))}
          className="h-7 pr-7 text-right text-xs tabular"
        />
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[0.6875rem] text-subtle-foreground">
          {unit}
        </span>
      </div>
    </div>
  );

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
        {numberField("lim-lead", "Lead calls", limits.maxLeadCalls, "×", 1, 20, (n) => ({
          ...limits,
          maxLeadCalls: n,
        }))}
        {numberField("lim-total", "Total calls", limits.maxTotalCalls, "×", 1, 40, (n) => ({
          ...limits,
          maxTotalCalls: n,
        }))}
        {numberField("lim-call", "Per-call timeout", Math.round(limits.perCallTimeoutMs / 1000), "s", 5, 600, (n) => ({
          ...limits,
          perCallTimeoutMs: n * 1000,
        }))}
        {numberField("lim-hard", "Hard deadline", Math.round(limits.hardDeadlineMs / 1000), "s", 10, 1800, (n) => ({
          ...limits,
          hardDeadlineMs: n * 1000,
        }))}
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
