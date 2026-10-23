"use client";

// /crm/login-as?mode=ghost|impersonate&dealer=<uuid>&text_id=<id>&name=<name>
// Opened in a new tab from a company page's Links card: runs the platform's
// existing Ghost Mode / impersonate entry points (the same ones as the Dealers
// list), then lands on the dealer's dashboard.

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { loginAsDealer } from "@/lib/admin-login-as";

export default function LoginAsPage() {
  return <Suspense fallback={null}><LoginAs /></Suspense>;
}

function LoginAs() {
  const sp = useSearchParams();
  const [msg, setMsg] = useState("Signing in…");
  useEffect(() => {
    const mode = sp.get("mode"), uuid = sp.get("dealer") ?? "", textId = sp.get("text_id") ?? "", name = sp.get("name") ?? textId;
    if (!uuid || !textId) { setMsg("Missing dealer."); return; }
    (async () => {
      if (mode === "impersonate") {
        const err = await loginAsDealer({ uuid, textId, name });
        if (err) setMsg(`Couldn't log in: ${err}`);
        return;
      }
      const res = await fetch("/api/admin/ghost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ dealer_id: uuid }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) { setMsg(`Ghost Mode failed: ${j.error ?? `HTTP ${res.status}`}`); return; }
      localStorage.setItem("da_ghost", JSON.stringify({ dealer_name: j.dealer_name ?? name, dealer_text_id: j.dealer_text_id ?? textId, dealer_uuid: j.dealer_uuid ?? uuid }));
      window.location.href = "/dashboard";
    })();
  }, [sp]);
  return <p style={{ padding: 24, fontSize: 14, color: "var(--crm-muted)" }}>{msg}</p>;
}
