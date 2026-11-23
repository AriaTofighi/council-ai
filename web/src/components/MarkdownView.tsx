import React from "react";

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
            <button
              key={match.index}
              type="button"
              className="cite-pill"
              onClick={() => onCiteClick(hashCite[1]!)}
              title={`Inspect contribution ${hashCite[1]!}`}
            >
              {label}
            </button>,
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
          <button
            key={match.index}
            type="button"
            className="cite-pill"
            onClick={() => onCiteClick(cleanId)}
            title={`Inspect contribution ${cleanId}`}
          >
            {cleanId}
          </button>,
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
        elements.push(
          <div key={`tbl-${i}`} className="md-table-wrap">
            <table>
              <thead>
                <tr>
                  {header.map((cell, ci) => (
                    <th key={ci}>
                      {renderInline(cell, validCitationIds, onCiteClick)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>
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

  return <div className="markdown-body">{elements}</div>;
};
