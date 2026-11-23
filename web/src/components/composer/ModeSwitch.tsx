import { EyeOff } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { OrchestrationMode } from "@/types";

export function ModeSwitch({
  mode,
  independentFirstOpinions,
  disabled,
  onChangeMode,
  onChangeIndependent,
}: {
  mode: OrchestrationMode;
  independentFirstOpinions: boolean;
  disabled?: boolean;
  onChangeMode: (m: OrchestrationMode) => void;
  onChangeIndependent: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-0.5">
      <Segmented<OrchestrationMode>
        aria-label="Mode"
        size="sm"
        value={mode}
        disabled={disabled}
        onValueChange={onChangeMode}
        className="h-7"
        options={[
          { value: "roundtable", label: "Roundtable" },
          { value: "divide_conquer", label: "Divide" },
        ]}
      />
      {mode === "roundtable" && (
        <Hint label={independentFirstOpinions ? "Blind first opinions: on" : "Blind first opinions: off"}>
          <button
            type="button"
            aria-pressed={independentFirstOpinions}
            aria-label="Independent first opinions"
            disabled={disabled}
            onClick={() => onChangeIndependent(!independentFirstOpinions)}
            className={cn(
              "grid size-7 place-items-center rounded-md outline-none transition-colors duration-(--duration-fast)",
              "focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50",
              independentFirstOpinions ? "text-signal" : "text-subtle-foreground hover:text-foreground",
            )}
          >
            <EyeOff className="size-3.5" />
          </button>
        </Hint>
      )}
    </div>
  );
}
