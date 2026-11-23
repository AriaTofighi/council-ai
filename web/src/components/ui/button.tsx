import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium",
    "transition-[background-color,color,box-shadow,transform,opacity] duration-(--duration-fast) ease-out",
    "outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35",
    "active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-xs hover:bg-primary/88",
        signal: "bg-signal text-signal-foreground shadow-xs hover:bg-signal/90",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/70",
        outline:
          "border border-border bg-card text-foreground shadow-xs hover:bg-accent hover:border-border-strong",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive: "bg-danger-soft text-danger hover:bg-danger/18",
        link: "h-auto px-0 text-signal underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-3.5",
        sm: "h-8 rounded-sm px-2.5 text-[0.8125rem]",
        xs: "h-7 rounded-sm px-2 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-11 rounded-lg px-5 text-[0.9375rem]",
        icon: "size-9",
        "icon-sm": "size-8 rounded-sm",
        "icon-xs": "size-7 rounded-sm [&_svg:not([class*='size-'])]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
