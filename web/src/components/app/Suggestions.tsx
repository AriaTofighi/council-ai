const SUGGESTIONS = [
  "Review this repository’s architecture and name the three riskiest areas",
  "Debate whether the server should be split into separate services",
  "Propose a test strategy for the orchestration loop and divide the work",
];

export function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  return (
    <ul className="flex flex-col">
      {SUGGESTIONS.map((s) => (
        <li key={s}>
          <button
            type="button"
            onClick={() => onPick(s)}
            className="w-full rounded-md px-3 py-1.5 text-left text-[0.8125rem] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent"
          >
            {s}
          </button>
        </li>
      ))}
    </ul>
  );
}
