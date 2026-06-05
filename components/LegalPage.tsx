import { readFileSync } from "fs";
import { join } from "path";
import Link from "next/link";

// Lightweight, dependency-free renderer for the legal markdown in
// docs/legal/*.md. The source uses only: `# H1`, `## H2`, `- ` bullet lists,
// paragraphs, and `**bold**` inline — so a tiny parser keeps the page on-brand
// without pulling in an MDX/markdown toolchain. The SAME markdown files are the
// canonical source shared (copied byte-identical) with the marketing site so the
// two never drift.

const NAVY = "#2a2b3c";
const BLUE = "#1976d2";

function renderInline(text: string): React.ReactNode[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter(Boolean)
    .map((part, i) =>
      part.startsWith("**") && part.endsWith("**")
        ? <strong key={i} style={{ color: NAVY, fontWeight: 600 }}>{part.slice(2, -2)}</strong>
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
      <ul key={`ul-${key++}`} style={{ margin: "0 0 18px", paddingLeft: 22, lineHeight: 1.75 }}>
        {items.map((it, i) => (
          <li key={i} style={{ marginBottom: 8, color: "#333" }}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("## ")) {
      flushList();
      blocks.push(
        <h2 key={`h2-${key++}`} style={{ fontSize: 20, fontWeight: 600, color: NAVY, margin: "34px 0 12px" }}>
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith("# ")) {
      flushList();
      blocks.push(
        <h1 key={`h1-${key++}`} style={{ fontSize: 30, fontWeight: 700, color: NAVY, margin: "0 0 16px", lineHeight: 1.25 }}>
          {renderInline(line.slice(2))}
        </h1>
      );
    } else if (line.startsWith("- ")) {
      list.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={`p-${key++}`} style={{ margin: "0 0 16px", lineHeight: 1.8, color: "#333" }}>
          {renderInline(line)}
        </p>
      );
    }
  }
  flushList();
  return blocks;
}

export default function LegalPage({ file }: { file: string }) {
  const md = readFileSync(join(process.cwd(), "docs", "legal", file), "utf-8");

  return (
    <main style={{ fontFamily: "'Roboto', Arial, sans-serif", background: "#fff", minHeight: "100vh" }}>
      <nav style={{
        background: NAVY, height: 52, display: "flex", alignItems: "center",
        justifyContent: "space-between", padding: "0 24px", position: "sticky", top: 0, zIndex: 10,
      }}>
        <Link href="/" style={{ textDecoration: "none", display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ background: "#ffa500", color: NAVY, fontWeight: 700, fontSize: 11, padding: "3px 8px", borderRadius: 4, letterSpacing: "0.08em" }}>DA</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#fff" }}>DealerAddendums</span>
        </Link>
        <Link href="/login" style={{ fontSize: 14, color: "rgba(255,255,255,0.75)", textDecoration: "none" }}>
          ← Back to sign in
        </Link>
      </nav>

      <article style={{ maxWidth: 760, margin: "0 auto", padding: "48px 24px 80px", fontSize: 15 }}>
        {renderMarkdown(md)}

        <hr style={{ border: "none", borderTop: "1px solid #e0e0e0", margin: "40px 0 20px" }} />
        <p style={{ fontSize: 14, color: "#78828c", margin: 0 }}>
          <Link href="/terms" style={{ color: BLUE, textDecoration: "none" }}>Terms of Use</Link>
          {"  ·  "}
          <Link href="/privacy" style={{ color: BLUE, textDecoration: "none" }}>Privacy Policy</Link>
          {"  ·  "}
          <Link href="/login" style={{ color: BLUE, textDecoration: "none" }}>Sign in</Link>
        </p>
      </article>
    </main>
  );
}
