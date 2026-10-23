// DA-CRM contacts ← platform users. The rules live in SQL (migration 188: crm_sync_user_contact,
// crm_sync_record_contact, crm_contacts_reconcile) so the profiles / dealers / groups triggers apply them in
// the platform's own transaction. This wraps the reconcile (backfill + nightly) and the re-matching.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { rematchContacts, type RematchReport } from "./contact-rematch";

export type ReconcileReport = {
  sync: Record<string, any>;
  rematch: RematchReport;
  /** What the reconcile had to change — zero when the live triggers kept up. */
  drift: { total: number; users: Record<string, number>; records: number };
};

const NOT_DRIFT = new Set(["unchanged", "skipped", "conflict"]);

export function driftOf(sync: Record<string, any>): ReconcileReport["drift"] {
  const users: Record<string, number> = {};
  for (const [k, v] of Object.entries(sync.users ?? {})) if (!NOT_DRIFT.has(k) && Number(v)) users[k] = Number(v);
  const records = Number(sync.records?.created ?? 0);
  return { total: Object.values(users).reduce((a, b) => a + b, 0) + records, users, records };
}

export async function reconcileContacts(admin: any, { apply }: { apply: boolean }): Promise<ReconcileReport> {
  const { data, error } = await admin.rpc("crm_contacts_reconcile", { p_apply: apply });
  if (error) throw new Error(`crm_contacts_reconcile: ${error.message}`);
  const sync = data as Record<string, any>;
  const rematch = await rematchContacts(admin, { apply });
  return { sync, rematch, drift: driftOf(sync) };
}
