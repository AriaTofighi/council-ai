import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-card px-3 text-sm shadow-xs",
        "placeholder:text-subtle-foreground selection:bg-signal-soft",
        "transition-[border-color,box-shadow] duration-(--duration-fast) ease-out outline-none",
        "focus-visible:border-signal/60 focus-visible:ring-[3px] focus-visible:ring-ring/20",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-danger/60 aria-invalid:ring-danger/20",
        "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
