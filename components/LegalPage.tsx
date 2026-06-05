import { readFileSync } from "fs";
import { join } from "path";
import LegalShell from "@/components/LegalShell";

// Renders the canonical legal markdown (docs/legal/*.md) inside the branded
// LegalShell. Source uses only `# H1`, `## H2`, `- ` lists, paragraphs, and
// `**bold**`; styling lives in LegalShell's .lp-doc CSS (screen + print).

function renderInline(text: string): React.ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i}>{part.slice(2, -2)}</strong>
        : <span key={i}>{part}</span>
    );
}

function renderMarkdown(md: string): React.ReactNode[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`ul-${key++}`}>
        {items.map((it, i) => <li key={i}>{renderInline(it)}</li>)}
      </ul>
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) { flushList(); blocks.push(<h2 key={`h2-${key++}`}>{renderInline(line.slice(3))}</h2>); }
    else if (line.startsWith("# ")) { flushList(); blocks.push(<h1 key={`h1-${key++}`}>{renderInline(line.slice(2))}</h1>); }
    else if (line.startsWith("- ")) { list.push(line.slice(2)); }
    else if (line.trim() === "") { flushList(); }
    else { flushList(); blocks.push(<p key={`p-${key++}`}>{renderInline(line)}</p>); }
  }
  flushList();
  return blocks;
}

export default function LegalPage({ file, title }: { file: string; title: string }) {
  const md = readFileSync(join(process.cwd(), "docs", "legal", file), "utf-8");
  return <LegalShell title={title}>{renderMarkdown(md)}</LegalShell>;
}
