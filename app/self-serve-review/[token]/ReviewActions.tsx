"use client";

import { useState } from "react";

export default function ReviewActions({ token, dealership }: { token: string; dealership: string }) {
  const [busy, setBusy] = useState<null | "approve" | "deny">(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: "approve" | "deny") {
    if (action === "approve" && !confirm(`Provision a Trial account for "${dealership}"?`)) return;
    if (action === "deny" && !confirm(`Discard this signup? Nothing will be created and the applicant is not emailed.`)) return;
    setBusy(action); setError(null);
    try {
      const res = await fetch("/api/self-serve/review", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, action }),
      });
      const json = await res.json() as { error?: string; action?: string };
      if (!res.ok) throw new Error(json.error ?? "Failed");
      setDone(json.action === "approved"
        ? "Approved — the Trial account has been provisioned and the welcome email sent."
        : "Denied — nothing was created.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally { setBusy(null); }
  }

  if (done) return <p style={{ fontSize: 14, fontWeight: 600, color: "#2e7d32" }}>{done}</p>;

  return (
    <div>
      {error && <p style={{ color: "#c62828", fontSize: 13 }}>{error}</p>}
      <div style={{ display: "flex", gap: 10 }}>
        <button type="button" disabled={busy !== null} onClick={() => void act("approve")}
          style={{ background: "#1976d2", color: "#fff", border: "none", padding: "10px 20px", borderRadius: 4, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>
          {busy === "approve" ? "Provisioning…" : "Approve & provision"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void act("deny")}
          style={{ background: "#fff", color: "#c62828", border: "1px solid #e0e0e0", padding: "10px 20px", borderRadius: 4, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", fontSize: 14 }}>
          {busy === "deny" ? "Discarding…" : "Deny"}
        </button>
      </div>
    </div>
  );
}
