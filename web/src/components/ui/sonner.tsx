import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "@/theme/theme-provider";

function Toaster(props: ToasterProps) {
  const { resolved } = useTheme();
  return (
    <Sonner
      theme={resolved}
      position="top-center"
      gap={8}
      toastOptions={{
        classNames: {
          toast:
            "!glass !rounded-xl !border !shadow-lg !text-popover-foreground !font-sans !text-[0.8125rem] !gap-2.5",
          description: "!text-muted-foreground",
          actionButton: "!bg-primary !text-primary-foreground !rounded-md",
          cancelButton: "!bg-muted !text-muted-foreground !rounded-md",
          error: "[&_[data-icon]]:!text-danger",
          success: "[&_[data-icon]]:!text-success",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
