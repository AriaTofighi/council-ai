import React from "react";
import { Gauge, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Hint } from "@/components/ui/tooltip";
import { PROVIDER_IDS, ProviderMark } from "@/lib/providers";
import { teammateLabel } from "@/lib/run-config";
import { cn } from "@/lib/utils";
import type { ParticipantSpec, ProviderCatalogEntry, ProviderId } from "@/types";
import { ParticipantEditor } from "./ParticipantEditor";

interface TeamSheetProps {
  lead: ParticipantSpec;
  teammates: ParticipantSpec[];
  catalog: ProviderCatalogEntry[];
  disabled?: boolean;
  onChangeLead: (next: ParticipantSpec) => void;
  onChangeTeammates: (next: ParticipantSpec[]) => void;
  onApplyFastPreset: () => void;
}

/** Provider glyphs (lead first, then team) that open the team sheet. */
const TeamTrigger = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<"button"> & { lead: ParticipantSpec; teammates: ParticipantSpec[] }
>(({ lead, teammates, className, ...props }, ref) => (
  <button
    ref={ref}
    type="button"
    aria-label="Team"
    className={cn(
      "flex h-7 items-center gap-1.5 rounded-md px-2 outline-none transition-colors duration-(--duration-fast)",
      "hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30",
      className,
    )}
    {...props}
  >
    <ProviderMark provider={lead.provider} size="sm" />
    {teammates.length > 0 && <span className="h-3 w-px bg-border-strong" aria-hidden />}
    {teammates.slice(0, 5).map((t, i) => (
      <ProviderMark key={t.id ?? i} provider={t.provider} size="sm" />
    ))}
    {teammates.length > 5 && (
      <span className="text-[0.6875rem] text-subtle-foreground tabular">+{teammates.length - 5}</span>
    )}
  </button>
));
TeamTrigger.displayName = "TeamTrigger";

export const TeamSheet: React.FC<TeamSheetProps> = ({
  lead,
  teammates,
  catalog,
  disabled,
  onChangeLead,
  onChangeTeammates,
  onApplyFastPreset,
}) => {
  const addTeammate = (provider: ProviderId) => {
    const n = teammates.filter((t) => t.provider === provider).length + (lead.provider === provider ? 1 : 0) + 1;
    onChangeTeammates([
      ...teammates,
      {
        id: `draft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        provider,
        label: teammateLabel(provider, lead.provider, n),
      },
    ]);
  };

  const updateTeammate = (idx: number, patch: Partial<ParticipantSpec>) =>
    onChangeTeammates(teammates.map((t, i) => (i === idx ? { ...t, ...patch } : t)));

  return (
    <Sheet>
      <Hint label="Team">
        <SheetTrigger asChild>
          <TeamTrigger lead={lead} teammates={teammates} />
        </SheetTrigger>
      </Hint>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Team</SheetTitle>
          <SheetDescription className="sr-only">Lead and teammates for the next turn</SheetDescription>
        </SheetHeader>

        <div className="scroll-quiet flex-1 space-y-5 overflow-y-auto px-5 pb-5">
          <section className="space-y-2">
            <h3 className="eyebrow">Lead</h3>
            <ParticipantEditor
              role="lead"
              participant={lead}
              catalog={catalog}
              disabled={disabled}
              onChange={(patch) => onChangeLead({ ...lead, ...patch })}
              onProviderChange={(provider) =>
                onChangeLead({ ...lead, provider, label: `${provider} lead`, model: undefined })
              }
            />
          </section>

          <section className="space-y-2">
            <h3 className="eyebrow">Teammates</h3>
            {teammates.map((mate, idx) => (
              <ParticipantEditor
                key={mate.id ?? idx}
                role="teammate"
                participant={mate}
                catalog={catalog}
                disabled={disabled}
                onChange={(patch) => updateTeammate(idx, patch)}
                onProviderChange={(provider) =>
                  updateTeammate(idx, {
                    provider,
                    label: teammateLabel(provider, lead.provider, idx + 1),
                    model: undefined,
                  })
                }
                onRemove={() => onChangeTeammates(teammates.filter((_, i) => i !== idx))}
              />
            ))}
            <div className="flex items-center gap-1">
              {PROVIDER_IDS.map((id) => (
                <Button
                  key={id}
                  variant="ghost"
                  size="xs"
                  disabled={disabled}
                  onClick={() => addTeammate(id)}
                  className="gap-1"
                >
                  <Plus className="text-subtle-foreground" />
                  <ProviderMark provider={id} size="xs" />
                  {id}
                </Button>
              ))}
            </div>
          </section>
        </div>

        <SheetFooter>
          <Button variant="ghost" size="xs" disabled={disabled} onClick={onApplyFastPreset} className="-ml-2">
            <Gauge /> Low-usage preset
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
};
