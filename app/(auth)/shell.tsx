// Shared visual shell for the /login and /signup (invite) pages. Both pages
// import <AuthShell> so the topbar, animated backdrop, card chrome, footer,
// and the full lp-* form primitive stylesheet stay defined in one place.
//
// Server component on purpose — the chrome is static markup. The consuming
// pages (login/page.tsx, signup/page.tsx) carry the "use client" directive
// for their form logic and Suspense boundaries; embedding a server component
// inside a client tree is fine and avoids re-rendering the backdrop on every
// form state change.

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? "5.0.0";
const BUILD_NUMBER = process.env.NEXT_PUBLIC_BUILD_NUMBER ?? "209";

const AUTH_CSS = `
  :root {
    --da-ink: #0B1220;
    --da-ink-2: #11192B;
    --da-blue: #2B5BD7;
    --da-red: #D03A2E;
    --da-amber: #E9A23B;
    --da-green: #2E8B57;
    --da-radius: 10px;
    --da-radius-lg: 16px;
    --da-text: #0B1220;
    --da-text-muted: #5A6478;
    --da-text-soft: #8A93A6;
    --da-line: #E5E3DA;
    --da-line-strong: #C9C6B8;
    --da-paper-2: #F2F1EC;
  }

  .lp-page {
    position: fixed;
    inset: 0;
    display: grid;
    grid-template-rows: auto 1fr auto;
    overflow: auto;
    font-family: 'Inter', system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
    color: var(--da-text);
    background: #0B1220;
  }

  /* Blobs */
  .lp-blob {
    position: absolute;
    border-radius: 50%;
    filter: blur(40px);
  }
  .lp-blob-a {
    width: 900px; height: 900px; left: -15%; top: -20%;
    background: radial-gradient(circle, rgba(43,91,215,.55), transparent 60%);
    animation: lpBlobA 22s ease-in-out infinite alternate;
  }
  .lp-blob-b {
    width: 800px; height: 800px; right: -15%; top: 20%;
    background: radial-gradient(circle, rgba(233,162,59,.45), transparent 60%);
    animation: lpBlobB 28s ease-in-out infinite alternate;
  }
  .lp-blob-c {
    width: 700px; height: 700px; left: 30%; bottom: -25%;
    background: radial-gradient(circle, rgba(110,68,200,.4), transparent 60%);
    animation: lpBlobC 25s ease-in-out infinite alternate;
  }

  /* Topbar */
  .lp-topbar {
    position: relative; z-index: 2;
    display: flex; justify-content: space-between; align-items: center;
    padding: 24px 40px;
    color: #fff;
  }
  .lp-logo {
    text-decoration: none;
    display: inline-flex; align-items: center;
  }
  .lp-logo img {
    height: 36px; width: auto;
    display: block;
  }
  .lp-topbar-right {
    display: flex; align-items: center; gap: 18px;
    color: rgba(255,255,255,.7); font-size: 13px;
  }
  .lp-topbar-right a {
    color: rgba(255,255,255,.85); text-decoration: none;
  }
  .lp-topbar-right a:hover { color: #fff; }
  .lp-status-pill {
    display: inline-flex; align-items: center; gap: 8px;
  }
  .lp-live-dot {
    display: inline-block;
    width: 6px; height: 6px; border-radius: 50%;
    background: #2E8B57;
    box-shadow: 0 0 0 0 rgba(46,139,87,.6);
    animation: lpLivePulse 2s ease-out infinite;
  }

  /* Card area */
  .lp-card-wrap {
    position: relative; z-index: 2;
    display: grid; place-items: center;
    padding: 24px 16px 64px;
  }
  .lp-card {
    width: 100%; max-width: 440px;
    background: rgba(255,255,255,0.96);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255,255,255,0.4);
    border-radius: var(--da-radius-lg);
    padding: 40px 40px 32px;
    box-shadow: 0 40px 80px -20px rgba(0,0,0,.5), 0 8px 16px -8px rgba(0,0,0,.3);
  }
  .lp-card-title {
    font-family: 'Newsreader', Georgia, serif;
    font-size: 32px; font-weight: 500; letter-spacing: -0.02em;
    margin: 0; color: var(--da-ink);
  }
  .lp-card-sub {
    font-size: 14.5px; color: var(--da-text-muted);
    margin: 6px 0 26px; line-height: 1.5;
  }

  /* Invite badge — only used by signup */
  .lp-invite-badge {
    display: inline-flex; align-items: center; gap: 6px;
    margin: -14px 0 22px;
    padding: 8px 12px;
    background: var(--da-paper-2);
    border: 1px solid var(--da-line);
    border-radius: 8px;
    font-size: 12.5px; line-height: 1.5;
    color: var(--da-text-muted);
  }
  .lp-invite-badge strong { color: var(--da-ink); font-weight: 600; }

  /* Strength meter */
  .lp-strength {
    display: flex; align-items: center; gap: 8px;
    margin-top: 8px; font-size: 11.5px;
  }
  .lp-strength-bar {
    flex: 1; height: 4px;
    background: var(--da-paper-2); border-radius: 2px; overflow: hidden;
  }
  .lp-strength-fill {
    height: 100%;
    transition: width .2s, background .2s;
  }
  .lp-strength-label {
    min-width: 60px; text-align: right; font-weight: 500;
  }

  /* Match hint under confirm password */
  .lp-match-hint {
    margin-top: 6px;
    font-size: 12px;
  }
  .lp-match-hint.ok    { color: var(--da-green); }
  .lp-match-hint.fail  { color: var(--da-red);   }

  /* Footer */
  .lp-footer {
    position: relative; z-index: 2;
    display: flex; justify-content: space-between; align-items: flex-end;
    padding: 0 40px 24px;
    color: rgba(255,255,255,.55); font-size: 12px;
  }
  .lp-footer a { color: rgba(255,255,255,.8); text-decoration: none; }
  .lp-footer a:hover { color: #fff; }
  .lp-footer-version {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    letter-spacing: .1em;
  }

  /* Form primitives */
  .lp-label {
    display: block;
    font-size: 12px; font-weight: 600;
    letter-spacing: 0.04em; text-transform: uppercase;
    color: var(--da-text-muted);
    margin-bottom: 8px;
  }
  .lp-input {
    width: 100%;
    height: 48px;
    padding: 0 14px;
    font-family: inherit; font-size: 15px;
    color: var(--da-text); background: #fff;
    border: 1px solid var(--da-line);
    border-radius: var(--da-radius);
    outline: none;
    transition: border-color .15s, box-shadow .15s;
    box-sizing: border-box;
  }
  .lp-input::placeholder { color: var(--da-text-soft); }
  .lp-input:hover { border-color: var(--da-line-strong); }
  .lp-input:focus {
    border-color: var(--da-blue);
    box-shadow: 0 0 0 4px rgba(43,91,215,.12);
  }
  .lp-input[readonly] {
    background: var(--da-paper-2);
    color: var(--da-text-muted);
    cursor: not-allowed;
  }
  .lp-input-error {
    border-color: var(--da-red) !important;
    box-shadow: 0 0 0 4px rgba(208,58,46,.10) !important;
  }
  .lp-pw-toggle {
    position: absolute; right: 12px; top: 50%; transform: translateY(-50%);
    color: var(--da-text-soft); cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    width: 28px; height: 28px; border-radius: 6px;
    background: transparent; border: none;
  }
  .lp-pw-toggle:hover { color: var(--da-text); background: var(--da-paper-2); }

  /* Buttons */
  .lp-btn {
    display: inline-flex; align-items: center; justify-content: center;
    gap: 8px; height: 48px; padding: 0 18px; width: 100%;
    font-family: inherit; font-size: 15px; font-weight: 600;
    white-space: nowrap;
    border-radius: var(--da-radius);
    border: 1px solid transparent; cursor: pointer;
    transition: transform .04s, background .15s, border-color .15s;
    user-select: none; box-sizing: border-box;
  }
  .lp-btn > svg { flex-shrink: 0; }
  .lp-btn:active { transform: translateY(1px); }
  .lp-btn:disabled { opacity: .65; cursor: not-allowed; }

  .lp-btn-primary { background: var(--da-ink); color: #fff; }
  .lp-btn-primary:hover:not(:disabled) { background: var(--da-ink-2, #11192B); }

  .lp-btn-passkey {
    background: #fff; color: var(--da-text);
    border-color: var(--da-line);
  }
  .lp-btn-passkey:hover:not(:disabled) {
    background: var(--da-paper-2);
    border-color: var(--da-line-strong);
  }

  .lp-btn-link {
    background: transparent; color: var(--da-text-muted);
    border: none; padding: 0;
    font-family: inherit; font-weight: 500; cursor: pointer;
    text-decoration: underline; text-decoration-color: transparent;
    text-underline-offset: 3px;
  }
  .lp-btn-link:hover { color: var(--da-text); text-decoration-color: currentColor; }

  /* Divider */
  .lp-divider {
    display: flex; align-items: center; gap: 12px;
    color: var(--da-text-soft);
    font-size: 12px; letter-spacing: .1em; text-transform: uppercase;
  }
  .lp-divider::before, .lp-divider::after {
    content: ''; flex: 1; height: 1px; background: var(--da-line);
  }

  /* Checkbox */
  .lp-checkbox {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 14px; color: var(--da-text-muted);
    cursor: pointer; user-select: none;
  }
  .lp-checkbox input {
    appearance: none; -webkit-appearance: none;
    width: 18px; height: 18px; flex-shrink: 0;
    border: 1.5px solid var(--da-line-strong);
    border-radius: 4px; background: #fff; cursor: pointer;
    transition: all .15s; position: relative;
  }
  .lp-checkbox input:hover { border-color: var(--da-text-muted); }
  .lp-checkbox input:checked { background: var(--da-ink); border-color: var(--da-ink); }
  .lp-checkbox input:checked::after {
    content: ''; position: absolute; left: 4px; top: 1px;
    width: 5px; height: 9px;
    border: solid #fff; border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  /* Errors */
  .lp-field-error {
    display: flex; gap: 6px; align-items: center;
    margin-top: 8px;
    color: var(--da-red); font-size: 12.5px;
    animation: lpFadeUp .2s ease both;
  }
  .lp-server-error {
    display: flex; gap: 10px; align-items: flex-start;
    background: rgba(208,58,46,.06);
    color: #7A1D15;
    border: 1px solid rgba(208,58,46,.2);
    padding: 10px 12px;
    border-radius: var(--da-radius);
    font-size: 13px; line-height: 1.45;
    animation: lpFadeUp .25s ease both;
  }

  /* Spinner */
  .lp-spinner {
    display: inline-block;
    width: 16px; height: 16px; border-radius: 50%;
    border: 2px solid currentColor; border-right-color: transparent;
    animation: lpSpin .7s linear infinite;
    flex-shrink: 0;
  }

  /* Keyframes */
  @keyframes lpSpin { to { transform: rotate(360deg); } }
  @keyframes lpFadeUp {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes lpShake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-3px); }
    40%, 60% { transform: translateX(3px); }
  }
  @keyframes lpLivePulse {
    0%   { box-shadow: 0 0 0 0 rgba(46,139,87,.55); }
    70%  { box-shadow: 0 0 0 8px rgba(46,139,87,0); }
    100% { box-shadow: 0 0 0 0 rgba(46,139,87,0); }
  }
  @keyframes lpBlobA {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(80px,40px) scale(1.1); }
  }
  @keyframes lpBlobB {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(-60px,-50px) scale(.9); }
  }
  @keyframes lpBlobC {
    0%   { transform: translate(0,0) scale(1); }
    100% { transform: translate(-40px,30px) scale(1.15); }
  }

  /* Responsive */
  @media (max-width: 640px) {
    .lp-topbar { padding: 20px; }
    .lp-topbar-right { gap: 12px; }
    .lp-topbar-right a:not(.lp-topbar-right .lp-status-pill + a) { display: none; }
    .lp-card { padding: 32px 24px 24px; border-radius: 12px; }
    .lp-footer { flex-direction: column; align-items: flex-start; gap: 6px; padding: 0 20px 20px; }
  }
`;

function MotionGradient() {
  return (
    <div style={{ position: "absolute", inset: 0, overflow: "hidden", background: "#0B1220" }}>
      <div className="lp-blob lp-blob-a" />
      <div className="lp-blob lp-blob-b" />
      <div className="lp-blob lp-blob-c" />
      <svg
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", mixBlendMode: "overlay", opacity: 0.35 }}
        aria-hidden
      >
        <filter id="lp-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" />
        </filter>
        <rect width="100%" height="100%" filter="url(#lp-grain)" />
      </svg>
      <div style={{ position: "absolute", inset: "auto 0 0 0", height: 1, background: "linear-gradient(90deg, transparent, rgba(255,255,255,.2), transparent)" }} />
    </div>
  );
}

/**
 * Shared chrome for /login and /signup: animated gradient backdrop, topbar
 * (logo + status pill + Help/Status), centered card, footer (Terms/Privacy +
 * version/build). The page passes `title` and `subtitle` for the card header
 * and renders any form/content as `children`.
 */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: AUTH_CSS }} />
      <div className="lp-page">
        <MotionGradient />

        <header className="lp-topbar">
          <a href="/" className="lp-logo" aria-label="Dealer Addendums home">
            <img src="/images/login-logo.svg" alt="Dealer Addendums" />
          </a>
          <div className="lp-topbar-right">
            <span className="lp-status-pill">
              <span className="lp-live-dot" aria-hidden />
              All systems normal
            </span>
            <a href="mailto:support@dealeraddendums.com">Help</a>
            <a href="https://status.dealeraddendums.com" target="_blank" rel="noopener noreferrer">Status</a>
          </div>
        </header>

        <main className="lp-card-wrap">
          <div className="lp-card">
            <h1 className="lp-card-title">{title}</h1>
            {subtitle && <p className="lp-card-sub">{subtitle}</p>}
            {children}
          </div>
        </main>

        <footer className="lp-footer">
          <div>
            © {new Date().getFullYear()} Dealer Addendums ·{" "}
            <a href="/terms">Terms</a> ·{" "}
            <a href="/privacy">Privacy</a>
          </div>
          <div className="lp-footer-version">v {APP_VERSION} · build {BUILD_NUMBER}</div>
        </footer>
      </div>
    </>
  );
}
