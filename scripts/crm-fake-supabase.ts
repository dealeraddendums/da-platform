// In-memory Supabase fake for the DA-CRM unit tests (test:crm-inbox,
// test:crm-feeds): just the query-builder surface lib/crm uses — select /
// insert / upsert (onConflict, ignoreDuplicates) / update, eq / is / in / not
// (is | in) / ilike / contains, "col->>key" JSON paths, order / limit,
// maybeSingle / single, and unique constraints that raise 23505.
/* eslint-disable @typescript-eslint/no-explicit-any */

export function fakeDb(seed: Record<string, any[]>, uniques: Record<string, string[][]> = DEFAULT_UNIQUES) {
  const tables: Record<string, any[]> = { ...seed };
  let seq = 0;
  const get = (r: any, k: string) => {
    const m = /^(\w+)->>(\w+)$/.exec(k);
    return m ? (r[m[1]] ?? {})[m[2]] ?? null : r[k];
  };
  const clash = (t: string, row: any, cols?: string[]) => (cols ? [cols] : uniques[t] ?? []).map((c) => (tables[t] ?? []).find((r) => r !== row && c.every((k) => row[k] != null && r[k] === row[k]))).find(Boolean);
  const parseList = (v: string) => v.replace(/^\(|\)$/g, "").split(",").map((x) => x.trim().replace(/^"|"$/g, ""));
  function builder(t: string) {
    const filters: ((r: any) => boolean)[] = [];
    let op: { kind: "select" | "insert" | "upsert" | "update" | "delete"; rows?: any[]; patch?: any; onConflict?: string; ignore?: boolean } = { kind: "select" };
    let limit = Infinity;
    let orderBy: { k: string; asc: boolean } | null = null;
    const run = () => {
      const all = tables[t] ?? (tables[t] = []);
      if (op.kind === "insert" || op.kind === "upsert") {
        const out: any[] = [];
        for (const raw of op.rows!) {
          const row = { id: `${t}-${++seq}`, created_at: new Date(Date.now() + seq).toISOString(), ...raw };
          const hit = op.kind === "upsert" && op.onConflict ? clash(t, row, op.onConflict.split(",")) : null;
          if (hit) { if (!op.ignore) { Object.assign(hit, raw); out.push(hit); } continue; }
          if (clash(t, row)) return { data: null, error: { code: "23505", message: "duplicate key" } };
          all.push(row); out.push(row);
        }
        return { data: out, error: null };
      }
      let hits = all.filter((r) => filters.every((f) => f(r)));
      if (op.kind === "update") { hits.forEach((r) => Object.assign(r, op.patch)); return { data: hits, error: null }; }
      if (op.kind === "delete") { tables[t] = all.filter((r) => !hits.includes(r)); return { data: hits, error: null }; }
      if (orderBy) { const { k, asc } = orderBy; hits = [...hits].sort((a, b) => (String(a[k]) < String(b[k]) ? -1 : 1) * (asc ? 1 : -1)); }
      return { data: hits.slice(0, limit), error: null };
    };
    const b: any = {
      select() { return b; },
      insert(rows: any) { op = { kind: "insert", rows: Array.isArray(rows) ? rows : [rows] }; return b; },
      upsert(rows: any, o: any = {}) { op = { kind: "upsert", rows: Array.isArray(rows) ? rows : [rows], onConflict: o.onConflict, ignore: !!o.ignoreDuplicates }; return b; },
      update(patch: any) { op = { kind: "update", patch }; return b; },
      delete() { op = { kind: "delete" }; return b; },
      eq(k: string, v: any) { filters.push((r) => get(r, k) === v); return b; },
      neq(k: string, v: any) { filters.push((r) => get(r, k) !== v); return b; },
      is(k: string, v: any) { filters.push((r) => (get(r, k) ?? null) === v); return b; },
      in(k: string, vs: any[]) { filters.push((r) => vs.includes(get(r, k))); return b; },
      not(k: string, o: string, v: any) {
        if (o === "in") { const list = parseList(String(v)); filters.push((r) => !list.includes(String(get(r, k)))); }
        else filters.push((r) => get(r, k) != null);
        return b;
      },
      contains(k: string, vs: any[]) { filters.push((r) => Array.isArray(r[k]) && vs.every((x) => r[k].includes(x))); return b; },
      ilike(k: string, v: string) {
        const re = new RegExp(`^${v.replace(/\\([\\%_])/g, "§$1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".").replace(/§(.)/g, (_m, c) => (c === "%" ? "%" : c === "_" ? "_" : "\\\\"))}$`, "i");
        filters.push((r) => re.test(String(get(r, k) ?? "")));
        return b;
      },
      or() { return b; },
      order(k: string, o: any = {}) { if (!orderBy) orderBy = { k, asc: o.ascending !== false }; return b; },
      limit(n: number) { limit = n; return b; },
      range() { return b; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error }); },
      single() { const r = run(); return Promise.resolve({ data: r.data?.[0] ?? null, error: r.error ?? (r.data?.length ? null : { message: "no rows" }) }); },
      then(res: any, rej: any) { return Promise.resolve(run()).then(res, rej); },
    };
    return b;
  }
  return {
    from: (t: string) => builder(t),
    rpc: async () => ({ data: [], error: null }),
    rows: (t: string) => tables[t] ?? [],
  } as any;
}

export const DEFAULT_UNIQUES: Record<string, string[][]> = {
  crm_email_threads: [["mailbox_id", "graph_conversation_id"]],
  crm_emails: [["graph_message_id"], ["mailbox_id", "internet_message_id"]],
  crm_email_participants: [["email_id", "address", "role"]],
  crm_activities: [["type", "external_id"]],
  crm_feed_unmatched: [["email_id"]],
};
