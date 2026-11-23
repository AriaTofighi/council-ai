import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-[1.375rem] w-9 shrink-0 items-center rounded-full p-[2px] outline-none",
        "transition-colors duration-(--duration-base) ease-out",
        "data-[state=checked]:bg-signal data-[state=unchecked]:bg-border-strong",
        "focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-[1.125rem] rounded-full bg-white shadow-sm ring-0",
          "transition-transform duration-(--duration-base) ease-spring",
          "data-[state=checked]:translate-x-[0.875rem] data-[state=unchecked]:translate-x-0",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
