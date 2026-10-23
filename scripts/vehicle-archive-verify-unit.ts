/* npm run test:vehicle-archive — lib/vehicle-archive.ts (POST /api/cron/archive-vehicles).
 *
 * The rule under test (2026-10-21): a vehicle is deleted from dealer_vehicles
 * only after its row AND its whole audit trail are in the archive tables. Any
 * copy failure skips the vehicle (kept, logged, retried next run).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { archiveVehicle } from "../lib/vehicle-archive";

let fail = 0;
function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) fail++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : `\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`}`);
}

type Op = "select" | "insert" | "upsert" | "delete" | "count";
type Tables = Record<string, any[]>;

/** Minimal Supabase stand-in. `failOn` = "table:op" pairs that return an error;
 *  `dropUpsert` silently loses upserted rows (an "ok" write that didn't land). */
function fakeDb(tables: Tables, opts: { failOn?: string[]; dropUpsert?: boolean } = {}) {
  const err = (t: string, op: Op) => (opts.failOn ?? []).includes(`${t}:${op}`) ? { message: `${t} ${op} failed` } : null;
  return {
    tables,
    from(t: string) {
      tables[t] ??= [];
      const filters: ((r: any) => boolean)[] = [];
      let op: Op = "select";
      let countMode = false;
      const run = () => {
        const e = err(t, countMode ? "count" : op);
        if (e) return { data: null, count: null, error: e };
        const rows = tables[t].filter((r) => filters.every((f) => f(r)));
        if (op === "delete") { tables[t] = tables[t].filter((r) => !rows.includes(r)); return { data: null, error: null }; }
        return { data: rows, count: rows.length, error: null };
      };
      const q: any = {
        select(_c?: string, o?: { count?: string; head?: boolean }) { countMode = !!o?.count; return q; },
        eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
        in(c: string, vs: unknown[]) { filters.push((r) => vs.includes(r[c])); return q; },
        order() { return q; },
        delete() { op = "delete"; return q; },
        maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
        insert(row: any) {
          const e = err(t, "insert"); if (!e) tables[t].push(...(Array.isArray(row) ? row : [row]));
          return Promise.resolve({ error: e });
        },
        upsert(rows: any[]) {
          const e = err(t, "upsert");
          if (!e && !opts.dropUpsert) for (const r of rows) if (!tables[t].some((x) => x.id === r.id)) tables[t].push(r);
          return Promise.resolve({ error: e });
        },
        then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
      };
      return q;
    },
  };
}

const V = { id: "veh-1", dealer_id: "D1", stock_number: "S1", status: "inactive" } as any;
const AUDIT = [
  { id: "a1", dealer_id: "D1", vehicle_id: "veh-1", stock_number: "S1", action: "created", method: "ui", changed_by: null, changed_by_email: null, changes: null, document_type: null, created_at: "2025-01-01" },
  { id: "a2", dealer_id: "D1", vehicle_id: "veh-1", stock_number: "S1", action: "updated", method: "feed", changed_by: null, changed_by_email: null, changes: null, document_type: null, created_at: "2025-02-01" },
];
const fresh = () => ({ dealer_vehicles: [{ ...V }], vehicle_audit_log: AUDIT.map((a) => ({ ...a })), dealer_vehicles_archive: [], vehicle_audit_log_archive: [] } as Tables);
const NOW = "2026-10-21T00:00:00Z";
const ids = (rows: any[]) => rows.map((r) => r.id ?? r.action).sort();

async function run() {
  // Happy path
  {
    const db = fakeDb(fresh());
    const r = await archiveVehicle(db, V, NOW);
    eq("happy: archived with 2 audit rows", r, { status: "archived", auditRows: 2 });
    eq("happy: deleted from dealer_vehicles", db.tables.dealer_vehicles.length, 0);
    eq("happy: row in archive", db.tables.dealer_vehicles_archive.map((x) => x.archive_reason), ["cron_6month_inactive"]);
    eq("happy: audit trail + archived event copied", ids(db.tables.vehicle_audit_log_archive), ["a1", "a2", "archived"]);
  }
  // Audit copy fails → skip, never delete (the bug this fixes)
  {
    const db = fakeDb(fresh(), { failOn: ["vehicle_audit_log_archive:upsert"] });
    const r = await archiveVehicle(db, V, NOW);
    eq("audit copy error: skipped with reason", r, { status: "skipped", reason: "audit copy: vehicle_audit_log_archive upsert failed" });
    eq("audit copy error: vehicle NOT deleted", db.tables.dealer_vehicles.length, 1);
  }
  // Upsert says ok but rows didn't land → verify catches it
  {
    const db = fakeDb(fresh(), { dropUpsert: true });
    const r = await archiveVehicle(db, V, NOW);
    eq("silent audit loss: verify skips", r, { status: "skipped", reason: "audit verify: 0 of 2 rows in the archive" });
    eq("silent audit loss: vehicle NOT deleted", db.tables.dealer_vehicles.length, 1);
  }
  // Audit read / verify query / vehicle insert errors → skip, keep
  for (const [label, failOn, reason] of [
    ["audit read error", "vehicle_audit_log:select", "audit read: vehicle_audit_log select failed"],
    ["audit verify query error", "vehicle_audit_log_archive:count", "audit verify: vehicle_audit_log_archive count failed"],
    ["vehicle archive insert error", "dealer_vehicles_archive:insert", "archive insert: dealer_vehicles_archive insert failed"],
  ] as const) {
    const db = fakeDb(fresh(), { failOn: [failOn] });
    const r = await archiveVehicle(db, V, NOW);
    eq(`${label}: skipped`, r, { status: "skipped", reason });
    eq(`${label}: vehicle NOT deleted`, db.tables.dealer_vehicles.length, 1);
  }
  // Retry after a failed audit copy: row already archived, audit re-copied, then deleted
  {
    const t = fresh();
    const first = fakeDb(t, { failOn: ["vehicle_audit_log_archive:upsert"] });
    await archiveVehicle(first, V, NOW);
    eq("retry: first run left the vehicle and an archive row", [t.dealer_vehicles.length, t.dealer_vehicles_archive.length], [1, 1]);
    const r = await archiveVehicle(fakeDb(t), V, NOW);
    eq("retry: archived on the next run", r, { status: "archived", auditRows: 2 });
    eq("retry: no duplicate vehicle archive row", t.dealer_vehicles_archive.length, 1);
    eq("retry: audit trail present before delete", ids(t.vehicle_audit_log_archive), ["a1", "a2", "archived"]);
    eq("retry: deleted", t.dealer_vehicles.length, 0);
  }
  // Archived-event log failure is informational: still archived
  {
    const db = fakeDb(fresh(), { failOn: ["vehicle_audit_log_archive:insert"] });
    const orig = console.error; console.error = () => {};
    const r = await archiveVehicle(db, V, NOW);
    console.error = orig;
    eq("event log error: still archived (trail already verified)", r, { status: "archived", auditRows: 2 });
  }
  // No audit history at all → archived
  {
    const t = fresh(); t.vehicle_audit_log = [];
    const r = await archiveVehicle(fakeDb(t), V, NOW);
    eq("no audit rows: archived", r, { status: "archived", auditRows: 0 });
  }
  // Delete error → reported as skipped (copy is in place, next run retries the delete)
  {
    const db = fakeDb(fresh(), { failOn: ["dealer_vehicles:delete"] });
    const r = await archiveVehicle(db, V, NOW);
    eq("delete error: skipped", r, { status: "skipped", reason: "delete: dealer_vehicles delete failed" });
  }

  console.log(fail ? `\n${fail} FAILED` : "\nall passed");
  process.exit(fail ? 1 : 0);
}

void run();
