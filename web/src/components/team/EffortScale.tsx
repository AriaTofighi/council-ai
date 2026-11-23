import { Hint } from "@/components/ui/tooltip";
import { EFFORT_LEVELS } from "@/lib/providers";
import { cn } from "@/lib/utils";
import type { ReasoningEffort } from "@/types";

/**
 * Thinking effort as a five-step signal meter. Click a step to set it; click the
 * active step again to fall back to the CLI default.
 */
export function EffortScale({
  value,
  onChange,
  disabled,
  lockedReason,
  levels,
}: {
  value?: ReasoningEffort;
  /** Levels the model accepts; others are shown but can't be picked. */
  levels?: ReasoningEffort[];
  onChange: (next: ReasoningEffort | undefined) => void;
  disabled?: boolean;
  lockedReason?: string;
}) {
  const activeIdx = value ? EFFORT_LEVELS.indexOf(value) : -1;
  const isDisabled = disabled || Boolean(lockedReason);

  const meter = (
    <div
      role="radiogroup"
      aria-label="Thinking effort"
      className={cn("flex items-center gap-2", isDisabled && "opacity-50")}
    >
      <div className="flex h-4 items-end gap-[2px]">
        {EFFORT_LEVELS.map((level, i) => {
          const on = i <= activeIdx;
          const unavailable = levels ? !levels.includes(level) : false;
          return (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={i === activeIdx}
              aria-label={level}
              title={unavailable ? `${level} isn’t available for this model` : level}
              disabled={isDisabled || unavailable}
              onClick={() => onChange(i === activeIdx ? undefined : level)}
              className="group/bar flex h-4 w-2 items-end outline-none focus-visible:ring-2 focus-visible:ring-ring/40 rounded-[2px] disabled:cursor-not-allowed"
            >
              <span
                className={cn(
                  "block w-full rounded-[2px] transition-[background-color,transform] duration-(--duration-base) ease-spring",
                  on
                    ? "bg-signal"
                    : unavailable
                      ? "bg-border opacity-40"
                      : "bg-border-strong group-hover/bar:bg-subtle-foreground",
                )}
                style={{ height: `${36 + i * 16}%` }}
              />
            </button>
          );
        })}
      </div>
      <span className="w-11 text-[0.6875rem] tabular text-muted-foreground">
        {lockedReason ? "none" : (value ?? "default")}
      </span>
    </div>
  );

  return lockedReason ? <Hint label={lockedReason}>{meter}</Hint> : meter;
}
