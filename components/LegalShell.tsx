import { AUTH_CSS, MotionGradient } from "@/app/(auth)/shell";
import DownloadPdfButton from "@/components/DownloadPdfButton";

// Branded shell for the public /terms and /privacy pages — reuses the login
// page's animated gradient backdrop + navy topbar (AUTH_CSS + MotionGradient),
// and floats the document on a wide white "sheet". The @media print block
// strips everything but the sheet (with a logo) so "Download PDF" (window.print
// → Save as PDF) yields a clean branded document.

const LEGAL_CSS = `
  .lp-doc-wrap {
    position: relative; z-index: 2;
    display: grid; place-items: start center;
    padding: 24px 16px 72px;
  }
  .lp-doc {
    width: 100%; max-width: 820px;
    background: #fff;
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: var(--da-radius-lg);
    padding: 48px 56px 44px;
    box-shadow: 0 40px 80px -20px rgba(0,0,0,.5), 0 8px 16px -8px rgba(0,0,0,.3);
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    color: var(--da-text);
  }
  .lp-doc-toolbar {
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; margin-bottom: 20px;
  }
  .lp-doc-back {
    font-size: 13.5px; color: var(--da-text-muted); text-decoration: none;
  }
  .lp-doc-back:hover { color: var(--da-text); }
  .lp-pdf-btn {
    display: inline-flex; align-items: center; gap: 7px;
    height: 38px; padding: 0 16px;
    font-family: inherit; font-size: 13.5px; font-weight: 600;
    color: #fff; background: var(--da-ink);
    border: none; border-radius: var(--da-radius); cursor: pointer;
    transition: background .15s;
  }
  .lp-pdf-btn:hover { background: var(--da-ink-2, #11192B); }
  .lp-pdf-btn > svg { flex-shrink: 0; }

  /* Print-only branding inside the sheet */
  .lp-print-logo { display: none; }

  /* Prose */
  .lp-doc h1 {
    font-family: 'Newsreader', Georgia, serif;
    font-size: 34px; font-weight: 600; letter-spacing: -0.02em;
    color: var(--da-ink); line-height: 1.2; margin: 0 0 14px;
  }
  .lp-doc h2 {
    font-size: 19px; font-weight: 600; color: var(--da-ink);
    margin: 34px 0 10px; letter-spacing: -0.01em;
  }
  .lp-doc p { font-size: 15px; line-height: 1.75; color: #2A3344; margin: 0 0 14px; }
  .lp-doc ul { margin: 0 0 16px; padding-left: 22px; }
  .lp-doc li { font-size: 15px; line-height: 1.7; color: #2A3344; margin-bottom: 8px; }
  .lp-doc strong { color: var(--da-ink); font-weight: 600; }
  .lp-doc-sep { border: none; border-top: 1px solid var(--da-line); margin: 36px 0 18px; }
  .lp-doc-footer { font-size: 13.5px; color: var(--da-text-muted); }
  .lp-doc-footer a { color: var(--da-blue); text-decoration: none; }
  .lp-doc-footer a:hover { text-decoration: underline; }

  @media (max-width: 640px) {
    .lp-doc { padding: 32px 22px 28px; border-radius: 12px; }
    .lp-doc h1 { font-size: 27px; }
  }

  @media print {
    .lp-backdrop, .lp-topbar, .lp-footer, .lp-doc-toolbar { display: none !important; }
    .lp-page { position: static; display: block; overflow: visible; background: #fff; }
    .lp-doc-wrap { padding: 0; display: block; }
    .lp-doc {
      max-width: none; border: none; border-radius: 0;
      box-shadow: none; padding: 0;
    }
    .lp-print-logo { display: block; height: 34px; margin: 0 0 24px; }
    .lp-doc h1, .lp-doc h2, .lp-doc strong { color: #000; }
    .lp-doc p, .lp-doc li { color: #111; }
  }
`;

export default function LegalShell({
  title,
  children,
}: {
  /** For accessibility / print logo alt only — the visible <h1> comes from the markdown. */
  title: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: AUTH_CSS + LEGAL_CSS }} />
      <div className="lp-page">
        <MotionGradient />

        <header className="lp-topbar">
          <a href="/" className="lp-logo" aria-label="Dealer Addendums home">
            <img src="/images/login-logo.svg" alt="Dealer Addendums" />
          </a>
          <div className="lp-topbar-right">
            <a href="/login">← Back to sign in</a>
          </div>
        </header>

        <main className="lp-doc-wrap">
          <article className="lp-doc">
            <div className="lp-doc-toolbar">
              <a href="/login" className="lp-doc-back">← Back to sign in</a>
              <DownloadPdfButton />
            </div>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="lp-print-logo" src="/images/login-logo.svg" alt={`Dealer Addendums — ${title}`} />
            {children}
            <hr className="lp-doc-sep" />
            <p className="lp-doc-footer">
              <a href="/terms">Terms of Use</a>{"  ·  "}
              <a href="/privacy">Privacy Policy</a>{"  ·  "}
              <a href="/login">Sign in</a>
            </p>
          </article>
        </main>
      </div>
    </>
  );
}
