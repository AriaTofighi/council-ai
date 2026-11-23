import React, { useEffect, useImperativeHandle, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Hint } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface ComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  running: boolean;
  submitting: boolean;
  stopping?: boolean;
  toolbar: React.ReactNode;
  className?: string;
  ref?: React.Ref<ComposerHandle>;
}

export function Composer({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  submitting,
  stopping,
  toolbar,
  className,
  ref,
}: ComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }), []);

  // Re-focus when a run finishes so the next turn is one keystroke away.
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) textareaRef.current?.focus();
    wasRunning.current = running;
  }, [running]);

  const canSend = value.trim().length > 0 && !submitting && !running;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSend) onSubmit();
      }}
      className={cn(
        "rounded-lg border bg-card shadow-sm transition-colors duration-(--duration-fast) focus-within:border-border-strong",
        className,
      )}
    >
      <Textarea
        ref={textareaRef}
        value={value}
        disabled={submitting}
        rows={1}
        aria-label="Message"
        placeholder="Ask the council"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            if (canSend) onSubmit();
          }
        }}
        className="max-h-[40vh] min-h-11 px-3 pb-1 pt-2.5 text-sm"
      />

      <div className="flex items-center gap-1 px-1.5 pb-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">{toolbar}</div>
        {running ? (
          <Hint label="Stop">
            <Button
              type="button"
              size="icon-xs"
              variant="secondary"
              disabled={stopping}
              onClick={onStop}
              aria-label="Stop run"
            >
              <Square className="size-2.5 fill-current" />
            </Button>
          </Hint>
        ) : (
          <Button type="submit" size="icon-xs" disabled={!canSend} aria-label="Send">
            <ArrowUp strokeWidth={2.5} />
          </Button>
        )}
      </div>
    </form>
  );
}
