"use client";

// Debounced real-time email availability check against GET /api/check-email.
// Used by the SuperAdmin (DealerList) and Group Admin (GroupDealerList) new
// dealer forms. Fail-open: network/API errors return to "idle" — the create
// routes still enforce uniqueness server-side, so the hook is a UX layer,
// never the gate.

import { useEffect, useState } from "react";

export type EmailCheckStatus = "idle" | "checking" | "available" | "taken";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function useEmailCheck(email: string): EmailCheckStatus {
  const [status, setStatus] = useState<EmailCheckStatus>("idle");

  useEffect(() => {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      setStatus("idle");
      return;
    }
    setStatus("checking");
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(`/api/check-email?email=${encodeURIComponent(trimmed)}`, {
            signal: ctrl.signal,
          });
          if (!res.ok) { setStatus("idle"); return; }
          const j = (await res.json()) as { available?: boolean };
          setStatus(j.available === false ? "taken" : "available");
        } catch {
          if (!ctrl.signal.aborted) setStatus("idle");
        }
      })();
    }, 500);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [email]);

  return status;
}

/** True while a check is pending or the email is taken — used to hold the
 *  submit button. Idle/available (and error → idle) never block. */
export function emailCheckBlocksSubmit(...statuses: EmailCheckStatus[]): boolean {
  return statuses.some((s) => s === "checking" || s === "taken");
}
