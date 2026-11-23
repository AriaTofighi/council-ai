import type { ReactNode } from "react";

export function CitePill({ id, onClick, label }: { id: string; onClick: () => void; label?: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Inspect contribution ${id}`}
      className="inline-flex h-[1.125rem] items-center rounded-sm bg-signal-soft px-1 align-baseline font-mono text-[0.6875rem] font-medium text-signal outline-none transition-[background-color,box-shadow] hover:bg-signal/20 focus-visible:ring-2 focus-visible:ring-ring/40"
    >
      {label ?? id}
    </button>
  );
}
