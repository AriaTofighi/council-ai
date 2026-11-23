import * as React from "react";
import { ToggleGroup as ToggleGroupPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

/**
 * Apple-style segmented control built on Radix ToggleGroup (single, required).
 */
function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  disabled,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onValueChange: (v: T) => void;
  options: Array<{ value: T; label: React.ReactNode; icon?: React.ReactNode }>;
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onValueChange={(v) => v && onValueChange(v as T)}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5",
        size === "sm" ? "h-8" : "h-9",
        className,
      )}
    >
      {options.map((opt) => (
        <ToggleGroupPrimitive.Item
          key={opt.value}
          value={opt.value}
          className={cn(
            "inline-flex h-full flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium text-muted-foreground outline-none",
            size === "sm" ? "text-xs" : "text-[0.8125rem]",
            "transition-[color,background-color,box-shadow] duration-(--duration-base) ease-out",
            "hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30",
            "data-[state=on]:bg-card data-[state=on]:text-foreground data-[state=on]:shadow-sm",
            "disabled:opacity-50 [&_svg]:size-3.5",
          )}
        >
          {opt.icon}
          {opt.label}
        </ToggleGroupPrimitive.Item>
      ))}
    </ToggleGroupPrimitive.Root>
  );
}

export { Segmented };
