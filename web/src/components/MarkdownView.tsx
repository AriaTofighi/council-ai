import React from "react";
import { cn } from "@/lib/utils";
import { CitePill } from "./turn/CitePill";

interface MarkdownViewProps {
  text: string;
  validCitationIds?: Set<string>;
  onCiteClick?: (contributionId: string) => void;
}

function renderInline(
  line: string,
  validCitationIds?: Set<string>,
  onCiteClick?: (id: string) => void,
): React.ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\[(?:t\d+_)?c_\d+\]|\b(?:t\d+_)?c_\d+\b)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      parts.push(line.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith("**") && token.endsWith("**")) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("`") && token.endsWith("`")) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const linkMatch = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (linkMatch) {
        const label = linkMatch[1]!;
        const target = linkMatch[2]!;
        const hashCite = /^#((?:t\d+_)?c_\d+)$/.exec(target);
        if (hashCite && validCitationIds?.has(hashCite[1]!) && onCiteClick) {
          parts.push(
            <CitePill key={match.index} id={hashCite[1]!} label={label} onClick={() => onCiteClick(hashCite[1]!)} />,
          );
        } else if (/^https?:\/\//i.test(target)) {
          parts.push(
            <a key={match.index} href={target} target="_blank" rel="noreferrer">
              {label}
            </a>,
          );
        } else {
          parts.push(
            <code key={match.index} title={target}>
              {label}
            </code>,
          );
        }
      } else {
        parts.push(token);
      }
    } else {
      const cleanId = token.replace(/^\[|\]$/g, "");
      if (validCitationIds?.has(cleanId) && onCiteClick) {
        parts.push(
          <CitePill key={match.index} id={cleanId} onClick={() => onCiteClick(cleanId)} />,
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < line.length) {
    parts.push(line.slice(lastIndex));
  }
  return parts;
}

/** Visible text of a markdown cell (formatting marks and link targets removed). */
function plainCell(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`]/g, "")
    .trim();
}

const NUMERIC_CELL = /^[-+~≈]?\$?\d[\d.,]*\s*(%|\/\s*\d+|x|×)?$/i;

/**
 * Per-column layout so short columns never wrap and label columns keep a readable width,
 * leaving the long prose column(s) to absorb the rest.
 */
function columnStyles(rows: string[][]): Array<{ className?: string; style?: React.CSSProperties }> {
  const cols = Math.max(...rows.map((r) => r.length));
  const stats = Array.from({ length: cols }, (_, c) => {
    const cells = rows.map((r) => plainCell(r[c] ?? "")).filter(Boolean);
    const lengths = cells.map((t) => t.length);
    const max = lengths.length ? Math.max(...lengths) : 0;
    const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0;
    const body = cells.slice(1);
    const sorted = body.map((t) => t.length).sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
    const numericShare = body.length ? body.filter((t) => NUMERIC_CELL.test(t)).length / body.length : 0;
    return { max, avg, median, numeric: numericShare >= 0.75 };
  });
  const widest = stats.reduce((best, s, i) => (s.avg > stats[best]!.avg ? i : best), 0);
  return stats.map((s, i) => {
    // width:1% shrink-wraps the column to its content so prose columns get the slack.
    if (s.max <= 18) {
      return { className: cn("whitespace-nowrap", s.numeric && "tabular"), style: { width: "1%" } };
    }
    // Mostly short (scores, counts) with the odd longer note: hug the typical cell, let outliers wrap.
    if (s.numeric || s.median <= 14) {
      return { className: cn(s.numeric && "tabular"), style: { width: "1%", minWidth: `${Math.max(s.median, 6)}ch` } };
    }
    if (i === widest) return {};
    // A label-ish column: wide enough for a few words per line, never squeezed to one.
    return { style: { minWidth: `${Math.min(Math.max(Math.ceil(s.max / 2.5), 12), 24)}ch` } };
  });
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({
  text,
  validCitationIds,
  onCiteClick,
}) => {
  const normalized = text.includes("\n") ? text : text.replace(/\\n/g, "\n");
  const lines = normalized.split(/\r?\n/);
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim().startsWith("```")) {
      const lang = line.trim().slice(3).trim();
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith("```")) {
        codeLines.push(lines[i]!);
        i += 1;
      }
      elements.push(
        <pre key={`code-${i}`} className="md-code">
          {lang && <span className="md-code-lang">{lang}</span>}
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      i += 1;
      continue;
    }

    const headingMatch = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const content = renderInline(
        headingMatch[2]!,
        validCitationIds,
        onCiteClick,
      );
      const Tag = `h${Math.min(level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
      elements.push(<Tag key={`h-${i}`}>{content}</Tag>);
      i += 1;
      continue;
    }

    if (/^[-*]\s+/.test(line.trim())) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i]!.trim())) {
        items.push(
          <li key={`li-${i}`}>
            {renderInline(
              lines[i]!.trim().replace(/^[-*]\s+/, ""),
              validCitationIds,
              onCiteClick,
            )}
          </li>,
        );
        i += 1;
      }
      elements.push(<ul key={`ul-${i}`}>{items}</ul>);
      continue;
    }

    if (/^\d+\.\s+/.test(line.trim())) {
      const items: React.ReactNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i]!.trim())) {
        items.push(
          <li key={`oli-${i}`}>
            {renderInline(
              lines[i]!.trim().replace(/^\d+\.\s+/, ""),
              validCitationIds,
              onCiteClick,
            )}
          </li>,
        );
        i += 1;
      }
      elements.push(<ol key={`ol-${i}`}>{items}</ol>);
      continue;
    }

    if (line.trim().startsWith("|") && lines[i + 1]?.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        tableLines.push(lines[i]!.trim());
        i += 1;
      }
      const rows = tableLines
        .filter((r) => !/^\|[\s:-]+\|$/.test(r.replace(/\|/g, "|")))
        .filter((r) => !/^[\s|:-]+$/.test(r))
        .map((r) =>
          r
            .slice(1, r.endsWith("|") ? -1 : undefined)
            .split("|")
            .map((cell) => cell.trim()),
        );
      if (rows.length > 0) {
        const header = rows[0]!;
        const body = rows.slice(1);
        const layout = columnStyles(rows);
        elements.push(
          <div key={`tbl-${i}`} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={ci} className={layout[ci]?.className} style={layout[ci]?.style}>
                      {renderInline(cell, validCitationIds, onCiteClick)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci} className={layout[ci]?.className} style={layout[ci]?.style}>
                        {renderInline(cell, validCitationIds, onCiteClick)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>,
        );
        continue;
      }
    }

    if (!line.trim()) {
      i += 1;
      continue;
    }

    elements.push(
      <p key={`p-${i}`}>
        {renderInline(line, validCitationIds, onCiteClick)}
      </p>,
    );
    i += 1;
  }

  return <div className="prose-council">{elements}</div>;
};
