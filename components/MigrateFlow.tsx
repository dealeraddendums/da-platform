"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

// Phase 13a.2 — dealer-facing guided self-migration. 4 steps:
//   code → confirm dealership → set up 5.0 login → review plan/billing → confirm.
// Side-effect-free until the final Confirm: verify is read-only and the account
// + all system actions happen at confirm (13a.3). Login choice + corrections are
// held client-side and submitted on Confirm.

const NAVY = "#2a2b3c", BLUE = "#1976d2";

interface StagedDealer {
  name: string; address: string | null; city: string | null; state: string | null; zip: string | null;
  phone: string | null; primary_contact: string | null; primary_contact_email: string | null;
  logo_url: string | null; inventoryCount: number;
  users: { email: string | null; name: string | null; role: string | null }[];
}
interface Plan { label: string; price: number; }
type Step = "code" | "dealership" | "login" | "review" | "done";

const card: React.CSSProperties = { background: "#fff", border: "1px solid #e0e0e0", borderRadius: 10, overflow: "hidden", maxWidth: 560, width: "100%" };
const body: React.CSSProperties = { padding: "28px 32px" };
const label: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, color: "#55595c", marginBottom: 6 };
const input: React.CSSProperties = { width: "100%", height: 40, padding: "0 12px", border: "1px solid #cccccc", borderRadius: 6, fontSize: 14, boxSizing: "border-box" };
const btn: React.CSSProperties = { width: "100%", height: 44, borderRadius: 6, border: "none", background: BLUE, color: "#fff", fontSize: 15, fontWeight: 600, cursor: "pointer" };
const btnDisabled: React.CSSProperties = { ...btn, background: "#9bbfe6", cursor: "default" };
const errBox: React.CSSProperties = { background: "#ffebee", color: "#c62828", borderRadius: 6, padding: "10px 12px", fontSize: 13, marginBottom: 14 };

function StepDots({ step }: { step: Step }) {
  const order: Step[] = ["code", "dealership", "login", "review"];
  const idx = step === "done" ? order.length : order.indexOf(step);
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 14 }}>
      {order.map((_, i) => (
        <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= idx ? "#ffa500" : "rgba(255,255,255,0.25)" }} />
      ))}
    </div>
  );
}

export default function MigrateFlow() {
  const token = useSearchParams().get("invite") ?? "";

  const [step, setStep] = useState<Step>("code");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [dealer, setDealer] = useState<StagedDealer | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [corrections, setCorrections] = useState<{ phone: string; primary_contact: string; primary_contact_email: string }>({ phone: "", primary_contact: "", primary_contact_email: "" });
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [pendingMsg, setPendingMsg] = useState("");

  // Inert prefill — show the email the invite was sent to.
  useEffect(() => {
    if (!token) { setLoadError("This migration link is missing its code. Please use the link from your email."); return; }
    fetch(`/api/migrate/verify?token=${encodeURIComponent(token)}`)
      .then(r => r.json())
      .then((j: { email?: string; error?: string }) => { if (j.error) setLoadError(j.error); else setEmail(j.email ?? ""); })
      .catch(() => setLoadError("Couldn't load your migration link. Please try again."));
  }, [token]);

  async function submitCode(e: React.FormEvent) {
    e.preventDefault(); setError(""); setLoading(true);
    try {
      const res = await fetch("/api/migrate/verify", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, code: code.trim() }) });
      const j = await res.json();
      if (!res.ok) { setError(j.error ?? "That code didn't work."); return; }
      setDealer(j.dealer); setPlan(j.plan);
      setCorrections({ phone: j.dealer.phone ?? "", primary_contact: j.dealer.primary_contact ?? "", primary_contact_email: j.dealer.primary_contact_email ?? "" });
      setStep("dealership");
    } catch { setError("Something went wrong. Please try again."); } finally { setLoading(false); }
  }

  async function submitConfirm() {
    setError(""); setLoading(true);
    try {
      const res = await fetch("/api/migrate/confirm", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, code: code.trim(), password, corrections }),
      });
      const j = await res.json();
      // 13a.2: confirm is a stub returning { pending: true } (202). 13a.3 will
      // perform the real activation. Either way, show the dealer a clear state.
      if (j.pending) { setPendingMsg(j.message ?? "Your migration is being finalized."); setStep("done"); return; }
      if (!res.ok) { setError(j.error ?? "Couldn't finish your migration."); return; }
      setPendingMsg(j.message ?? "Migration complete!"); setStep("done");
    } catch { setError("Something went wrong finishing your migration. Please try again."); } finally { setLoading(false); }
  }

  const passwordsOk = password.length >= 8 && password === confirm;

  // ── Render ─────────────────────────────────────────────────────────────────
  const Header = ({ title, subtitle }: { title: string; subtitle: string }) => (
    <div style={{ background: NAVY, padding: "28px 32px" }}>
      <img src="https://new-infobox-images.s3.us-east-1.amazonaws.com/da-logo.png" alt="DA Platform" width={40} height={40} style={{ borderRadius: "50%" }} />
      <h1 style={{ color: "#fff", fontSize: 20, fontWeight: 600, margin: "16px 0 4px" }}>{title}</h1>
      <p style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, margin: 0 }}>{subtitle}</p>
      {step !== "done" && <StepDots step={step} />}
    </div>
  );

  if (loadError) {
    return (
      <div style={card}>
        <Header title="Migration link issue" subtitle="We couldn't open this migration link." />
        <div style={body}><div style={errBox}>{loadError}</div>
          <p style={{ fontSize: 13, color: "#78828c" }}>Need help? Email <a href="mailto:support@dealeraddendums.com">support@dealeraddendums.com</a>.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={card}>
      {step === "code" && (
        <>
          <Header title="Migrate to the new DealerAddendums" subtitle="Enter the code from your invite email to get started." />
          <form onSubmit={submitCode} style={body}>
            <div style={{ marginBottom: 16 }}>
              <label style={label} htmlFor="m-email">Email</label>
              <input id="m-email" style={{ ...input, background: "#f5f6f7" }} value={email} readOnly />
            </div>
            <div style={{ marginBottom: 18 }}>
              <label style={label} htmlFor="m-code">Migration code</label>
              <input id="m-code" style={{ ...input, fontFamily: "'Courier New', monospace", fontSize: 22, letterSpacing: 8, textAlign: "center" }}
                inputMode="numeric" autoComplete="one-time-code" placeholder="8-digit code"
                value={code} onChange={e => setCode(e.target.value.replace(/\D/g, "").slice(0, 8))} />
            </div>
            {error && <div style={errBox}>{error}</div>}
            <button type="submit" style={loading || code.length < 8 ? btnDisabled : btn} disabled={loading || code.length < 8}>
              {loading ? "Verifying…" : "Verify & Continue"}
            </button>
          </form>
        </>
      )}

      {step === "dealership" && dealer && (
        <>
          <Header title="Confirm your dealership" subtitle="We pre-loaded your details. Check them and fix anything that's off." />
          <div style={body}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16 }}>
              {dealer.logo_url
                ? <img src={dealer.logo_url} alt="" style={{ width: 56, height: 56, objectFit: "contain", borderRadius: 6, border: "1px solid #eee" }} />
                : <div style={{ width: 56, height: 56, borderRadius: 6, background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center", color: "#9aa0a6", fontSize: 11 }}>no logo</div>}
              <div>
                <div style={{ fontSize: 17, fontWeight: 700 }}>{dealer.name}</div>
                <div style={{ fontSize: 13, color: "#78828c" }}>{[dealer.address, dealer.city, dealer.state, dealer.zip].filter(Boolean).join(", ") || "No address on file"}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 12, marginBottom: 18 }}>
              <div style={{ flex: 1, background: "#f5f6f7", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>{dealer.inventoryCount.toLocaleString()}</div>
                <div style={{ fontSize: 12, color: "#78828c" }}>vehicles in inventory</div>
              </div>
              <div style={{ flex: 1, background: "#f5f6f7", borderRadius: 6, padding: "10px 12px" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: NAVY }}>{dealer.users.length}</div>
                <div style={{ fontSize: 12, color: "#78828c" }}>user{dealer.users.length === 1 ? "" : "s"}</div>
              </div>
            </div>
            {dealer.users.length > 0 && (
              <div style={{ marginBottom: 18, fontSize: 13, color: "#55595c" }}>
                {dealer.users.slice(0, 6).map((u, i) => <div key={i}>• {u.name || u.email} <span style={{ color: "#9aa0a6" }}>({(u.role ?? "").replace(/_/g, " ")})</span></div>)}
              </div>
            )}
            <label style={label}>Main contact</label>
            <input style={{ ...input, marginBottom: 10 }} placeholder="Contact name" value={corrections.primary_contact} onChange={e => setCorrections(c => ({ ...c, primary_contact: e.target.value }))} />
            <input style={{ ...input, marginBottom: 10 }} placeholder="Contact email" value={corrections.primary_contact_email} onChange={e => setCorrections(c => ({ ...c, primary_contact_email: e.target.value }))} />
            <input style={{ ...input, marginBottom: 18 }} placeholder="Phone" value={corrections.phone} onChange={e => setCorrections(c => ({ ...c, phone: e.target.value }))} />
            {error && <div style={errBox}>{error}</div>}
            <button style={btn} onClick={() => { setError(""); setStep("login"); }}>Looks good — continue</button>
          </div>
        </>
      )}

      {step === "login" && (
        <>
          <Header title="Set up your new login" subtitle="Create a password for the new platform. (Your old password doesn't carry over.)" />
          <div style={body}>
            <div style={{ marginBottom: 14 }}>
              <label style={label} htmlFor="m-pw">New password</label>
              <input id="m-pw" style={input} type="password" autoComplete="new-password" placeholder="At least 8 characters" value={password} onChange={e => setPassword(e.target.value)} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={label} htmlFor="m-pw2">Confirm password</label>
              <input id="m-pw2" style={input} type="password" autoComplete="new-password" placeholder="Repeat password" value={confirm} onChange={e => setConfirm(e.target.value)} />
              {confirm.length > 0 && password !== confirm && <div style={{ fontSize: 12, color: "#c62828", marginTop: 4 }}>Passwords don't match</div>}
            </div>
            <p style={{ fontSize: 12, color: "#78828c", margin: "0 0 18px" }}>Prefer Face ID / Touch ID? You'll be offered a passkey right after you finish.</p>
            {error && <div style={errBox}>{error}</div>}
            <button style={passwordsOk ? btn : btnDisabled} disabled={!passwordsOk} onClick={() => { setError(""); setStep("review"); }}>Continue</button>
            <button style={{ ...btn, background: "none", color: "#78828c", height: 36, marginTop: 6, fontWeight: 500 }} onClick={() => setStep("dealership")}>← Back</button>
          </div>
        </>
      )}

      {step === "review" && plan && (
        <>
          <Header title="Review &amp; confirm" subtitle="Here's your plan. Nothing is charged today." />
          <div style={body}>
            <div style={{ border: "1px solid #e0e0e0", borderRadius: 8, padding: "16px 18px", marginBottom: 16 }}>
              <div style={{ fontSize: 13, color: "#78828c" }}>Your plan</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: NAVY }}>{plan.label} — ${plan.price}/mo</div>
            </div>
            <div style={{ background: "#fff8e1", border: "1px solid #ffe082", borderRadius: 8, padding: "12px 14px", fontSize: 13, color: "#6b5800", marginBottom: 18, lineHeight: 1.5 }}>
              <strong>How billing changes:</strong> going forward, your subscription is billed through DealerAddendums billing.
              Any <strong>outstanding balance on your current (FreshBooks) account stays due and is paid there</strong> as usual —
              we won't double-bill you for the changeover month.
            </div>
            {error && <div style={errBox}>{error}</div>}
            <button style={loading ? btnDisabled : btn} disabled={loading} onClick={submitConfirm}>{loading ? "Finishing…" : "Confirm migration"}</button>
            <button style={{ ...btn, background: "none", color: "#78828c", height: 36, marginTop: 6, fontWeight: 500 }} onClick={() => setStep("login")}>← Back</button>
          </div>
        </>
      )}

      {step === "done" && (
        <>
          <Header title="You're almost set" subtitle="" />
          <div style={body}>
            <div style={{ textAlign: "center", padding: "8px 0 20px" }}>
              <div style={{ fontSize: 40 }}>✅</div>
              <p style={{ fontSize: 15, color: "#333", lineHeight: 1.6, marginTop: 10 }}>{pendingMsg}</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
