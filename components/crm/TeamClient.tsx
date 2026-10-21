"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import RichTextEditor from "@/components/RichTextEditor";
import { formatPhone } from "@/lib/crm/phone";

export type Member = {
  staff_id: string;
  email: string;
  full_name: string | null;
  team: "customer_support" | "management";
  capabilities: string[];
  work_hours: Record<string, { start: string; end: string }>;
  time_zone: string;
  cell_phone: string | null;
  email_signature_html: string | null;
  has_photo: boolean;
  photo_v: string;
  dialpad_user_id: string | null;
  dialpad_number: string | null;
  active: boolean;
  is_admin: boolean;
};

// Mirrors lib/crm/team.ts (server-only because of DOMPurify).
const TEAMS: Record<string, string> = { customer_support: "Customer Support", management: "Management" };
const CAPABILITIES: Record<string, string> = { tier1: "Tier 1", tier2: "Tier 2", feed_support: "Feed support", ar_ap: "AR/AP" };
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABEL: Record<string, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const ZONES = ["America/Los_Angeles", "America/Denver", "America/Phoenix", "America/Chicago", "America/New_York", "Pacific/Honolulu", "America/Anchorage"];

function hoursSummary(h: Member["work_hours"]): string {
  const on = DAYS.filter((d) => h[d]);
  if (!on.length) return "Hours not set";
  const first = h[on[0]];
  const same = on.every((d) => h[d].start === first.start && h[d].end === first.end);
  return same ? `${on.map((d) => DAY_LABEL[d]).join(", ")} · ${first.start}–${first.end}` : on.map((d) => `${DAY_LABEL[d]} ${h[d].start}–${h[d].end}`).join(" · ");
}

async function api(url: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; data?: any }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const res = await fetch(url, {
    method,
    ...(body instanceof FormData ? { body } : body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const j = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: j } : { ok: false, error: j.error ?? `Request failed (${res.status})` };
}

export default function TeamClient({
  members, currentUserId, isAdmin, candidates, settings,
}: {
  members: Member[];
  currentUserId: string;
  isAdmin: boolean;
  candidates: { id: string; label: string }[];
  settings: { platform_name: string; has_logo: boolean; logo_v: string };
}) {
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <div style={{ display: "grid", gap: 16 }}>
      {isAdmin && <AddMember candidates={candidates} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {members.map((m) => (
          <div key={m.staff_id} className="card" style={{ padding: 16, opacity: m.active ? 1 : 0.6 }}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Avatar m={m} size={56} />
              <div style={{ minWidth: 0 }}>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{m.full_name || m.email}</p>
                <p style={{ margin: 0, fontSize: 12, color: "var(--text-secondary)" }}>
                  {TEAMS[m.team]}{m.is_admin ? " · DA-CRM admin" : ""}{m.active ? "" : " · inactive"}
                </p>
              </div>
            </div>
            {m.capabilities.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {m.capabilities.map((c) => <span key={c} style={{ background: "#e3f2fd", color: "#1565c0", fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 3 }}>{CAPABILITIES[c] ?? c}</span>)}
              </div>
            )}
            <dl style={{ margin: "10px 0 0", fontSize: 12, color: "var(--text-secondary)", display: "grid", gap: 2 }}>
              <div>{hoursSummary(m.work_hours)}</div>
              <div>{m.time_zone.replace("America/", "").replace("_", " ")}{m.cell_phone ? ` · cell ${formatPhone(m.cell_phone)}` : ""}</div>
              <div>Dialpad: {m.dialpad_user_id ? `user ${m.dialpad_user_id}${m.dialpad_number ? ` · ${formatPhone(m.dialpad_number)}` : ""}` : <span style={{ color: "var(--error)" }}>not mapped — click-to-call uses the phone app</span>}</div>
            </dl>
            {(isAdmin || m.staff_id === currentUserId) && (
              <button type="button" className="btn btn-secondary" style={{ marginTop: 12, height: 30, fontSize: 13 }} onClick={() => setEditing(editing === m.staff_id ? null : m.staff_id)}>
                {editing === m.staff_id ? "Close" : "Edit"}
              </button>
            )}
          </div>
        ))}
      </div>
      {editing && <MemberEditor key={editing} m={members.find((m) => m.staff_id === editing)!} isAdmin={isAdmin} self={editing === currentUserId} onDone={() => setEditing(null)} />}
      {isAdmin && <Settings settings={settings} />}
      {isAdmin && <Webhooks />}
    </div>
  );
}

function Avatar({ m, size }: { m: Member; size: number }) {
  const initials = (m.full_name || m.email).split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join("");
  return m.has_photo ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={`/api/crm/team/${m.staff_id}/photo?v=${m.photo_v}`} alt="" width={size} height={size} style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
  ) : (
    <div style={{ width: size, height: size, borderRadius: "50%", background: "var(--navy)", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, flexShrink: 0 }}>{initials}</div>
  );
}

function MemberEditor({ m, isAdmin, self, onDone }: { m: Member; isAdmin: boolean; self: boolean; onDone: () => void }) {
  const router = useRouter();
  const [f, setF] = useState({
    full_name: m.full_name ?? "", time_zone: m.time_zone, cell_phone: m.cell_phone ?? "",
    team: m.team, capabilities: m.capabilities, dialpad_user_id: m.dialpad_user_id ?? "", dialpad_number: m.dialpad_number ?? "",
    active: m.active, is_admin: m.is_admin,
  });
  const [hours, setHours] = useState(m.work_hours);
  const [sig, setSig] = useState(m.email_signature_html ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMsg(null);
    const body: Record<string, unknown> = {
      full_name: f.full_name, time_zone: f.time_zone, cell_phone: f.cell_phone || null, work_hours: hours, email_signature_html: sig,
      ...(isAdmin ? {
        team: f.team, capabilities: f.capabilities, dialpad_user_id: f.dialpad_user_id || null, dialpad_number: f.dialpad_number || null,
        ...(self ? {} : { active: f.active }), ...(f.is_admin !== m.is_admin ? { admin: f.is_admin } : {}),
      } : {}),
    };
    const r = await api(`/api/crm/team/${m.staff_id}`, "PATCH", body);
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: r.error! }); return; }
    router.refresh();
    onDone();
  }

  async function uploadPhoto(file: File) {
    const fd = new FormData();
    fd.append("file", file);
    const r = await api(`/api/crm/team/${m.staff_id}/photo`, "POST", fd);
    setMsg(r.ok ? { ok: true, text: "Photo updated" } : { ok: false, text: r.error! });
    if (r.ok) router.refresh();
  }

  return (
    <div className="card" style={{ padding: 16 }}>
      <p style={{ margin: "0 0 12px", fontWeight: 700 }}>Edit {m.full_name || m.email}</p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12 }}>
        <div><label className="label">Full name</label><input className="input" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></div>
        <div><label className="label">Time zone</label>
          <select className="input" value={f.time_zone} onChange={(e) => setF({ ...f, time_zone: e.target.value })}>
            {Array.from(new Set([f.time_zone, ...ZONES])).map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </div>
        <div><label className="label">Cell phone</label><input className="input" type="tel" value={f.cell_phone} onChange={(e) => setF({ ...f, cell_phone: e.target.value })} /></div>
        <div><label className="label">Photo</label><input type="file" accept="image/png,image/jpeg,image/webp" style={{ fontSize: 13 }} onChange={(e) => e.target.files?.[0] && uploadPhoto(e.target.files[0])} /></div>
      </div>

      {isAdmin && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginTop: 12 }}>
          <div><label className="label">Team</label>
            <select className="input" value={f.team} onChange={(e) => setF({ ...f, team: e.target.value as Member["team"] })}>
              {Object.entries(TEAMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div><label className="label">Dialpad user id</label><input className="input" value={f.dialpad_user_id} onChange={(e) => setF({ ...f, dialpad_user_id: e.target.value })} placeholder="e.g. 5908860123456789" /></div>
          <div><label className="label">Dialpad number</label><input className="input" type="tel" value={f.dialpad_number} onChange={(e) => setF({ ...f, dialpad_number: e.target.value })} /></div>
          <div>
            <label className="label">Capabilities</label>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", minHeight: 36, alignItems: "center" }}>
              {Object.entries(CAPABILITIES).map(([k, v]) => (
                <label key={k} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 13 }}>
                  <input type="checkbox" checked={f.capabilities.includes(k)} onChange={(e) => setF({ ...f, capabilities: e.target.checked ? [...f.capabilities, k] : f.capabilities.filter((c) => c !== k) })} /> {v}
                </label>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={f.is_admin} disabled={self && m.is_admin} onChange={(e) => setF({ ...f, is_admin: e.target.checked })} /> DA-CRM admin
            </label>
            {!self && (
              <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
              </label>
            )}
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <label className="label">Work hours</label>
        <div style={{ display: "grid", gap: 6 }}>
          {DAYS.map((d) => {
            const h = hours[d];
            return (
              <div key={d} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13 }}>
                <label style={{ width: 70, display: "inline-flex", gap: 6, alignItems: "center" }}>
                  <input type="checkbox" checked={!!h} onChange={(e) => {
                    const next = { ...hours };
                    if (e.target.checked) next[d] = { start: "08:00", end: "17:00" }; else delete next[d];
                    setHours(next);
                  }} /> {DAY_LABEL[d]}
                </label>
                {h ? (
                  <>
                    <input className="input" type="time" style={{ width: 130 }} value={h.start} onChange={(e) => setHours({ ...hours, [d]: { ...h, start: e.target.value } })} />
                    <span>–</span>
                    <input className="input" type="time" style={{ width: 130 }} value={h.end} onChange={(e) => setHours({ ...hours, [d]: { ...h, end: e.target.value } })} />
                  </>
                ) : <span style={{ color: "var(--text-muted)" }}>Off</span>}
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        <label className="label">Email signature</label>
        <RichTextEditor value={sig} onChange={setSig} minHeight={110} toolbarOpen />
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 16 }}>
        <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
        <button type="button" className="btn btn-secondary" onClick={onDone}>Cancel</button>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}

function AddMember({ candidates }: { candidates: { id: string; label: string }[] }) {
  const router = useRouter();
  const [id, setId] = useState("");
  const [team, setTeam] = useState("customer_support");
  const [err, setErr] = useState<string | null>(null);
  if (!candidates.length) return null;
  return (
    <div className="card" style={{ padding: 12, display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div style={{ minWidth: 280 }}><label className="label">Add a team member (DA staff login)</label>
        <select className="input" value={id} onChange={(e) => setId(e.target.value)}>
          <option value="">Choose…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </div>
      <div><label className="label">Team</label>
        <select className="input" value={team} onChange={(e) => setTeam(e.target.value)}>
          {Object.entries(TEAMS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </div>
      <button type="button" className="btn btn-primary" disabled={!id} onClick={async () => {
        const r = await api("/api/crm/team", "POST", { staff_id: id, team });
        if (!r.ok) setErr(r.error!); else { setId(""); router.refresh(); }
      }}>Add</button>
      {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
    </div>
  );
}

function Settings({ settings }: { settings: { platform_name: string; has_logo: boolean; logo_v: string } }) {
  const router = useRouter();
  const [name, setName] = useState(settings.platform_name);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="card" style={{ padding: 16 }}>
      <p style={{ margin: "0 0 12px", fontWeight: 700 }}>DA-CRM settings</p>
      <div style={{ display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <div style={{ minWidth: 240 }}><label className="label">Platform name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <button type="button" className="btn btn-primary" onClick={async () => {
          const r = await api("/api/crm/settings", "PATCH", { platform_name: name });
          setMsg(r.ok ? { ok: true, text: "Saved" } : { ok: false, text: r.error! });
          if (r.ok) router.refresh();
        }}>Save name</button>
        <div>
          <label className="label">Logo (PNG, JPEG or WebP)</label>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {settings.has_logo && <img src={`/api/crm/settings/logo?v=${settings.logo_v}`} alt="DA-CRM logo" height={36} style={{ maxWidth: 140, objectFit: "contain" }} />}
            <input type="file" accept="image/png,image/jpeg,image/webp" style={{ fontSize: 13 }} onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              const fd = new FormData();
              fd.append("file", file);
              const r = await api("/api/crm/settings/logo", "POST", fd);
              setMsg(r.ok ? { ok: true, text: "Logo updated" } : { ok: false, text: r.error! });
              if (r.ok) router.refresh();
            }} />
          </div>
        </div>
        {msg && <span style={{ fontSize: 12, color: msg.ok ? "var(--success)" : "var(--error)" }}>{msg.text}</span>}
      </div>
    </div>
  );
}

const EVENTS = ["company.stage_changed", "company.owner_changed", "contact.created", "contact.updated"];
type Sub = { id: string; name: string; url: string; events: string[]; active: boolean };
type Delivery = { id: string; subscription_id: string; event: string; status: string; attempts: number; last_status_code: number | null; last_error: string | null; created_at: string };

function Webhooks() {
  const [subs, setSubs] = useState<Sub[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [name, setName] = useState("da-billing");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>(EVENTS);
  const [err, setErr] = useState<string | null>(null);
  const load = async () => {
    const r = await api("/api/crm/webhooks", "GET");
    if (r.ok) { setSubs(r.data.subscriptions); setDeliveries(r.data.deliveries); }
  };
  useEffect(() => { void load(); }, []);

  return (
    <div className="card" style={{ padding: 16 }}>
      <p style={{ margin: "0 0 4px", fontWeight: 700 }}>Outbound webhooks</p>
      <p style={{ margin: "0 0 12px", fontSize: 12, color: "var(--text-muted)" }}>Signed with CRM_WEBHOOK_SECRET (X-DA-CRM-Signature). Failed deliveries retry with backoff for ~24 hours.</p>
      {subs.map((s) => (
        <div key={s.id} style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 13, padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
          <strong>{s.name}</strong><span style={{ color: "var(--text-secondary)", wordBreak: "break-all" }}>{s.url}</span>
          <span style={{ color: "var(--text-muted)", fontSize: 12 }}>{s.events.join(", ")}</span>
          <label style={{ marginLeft: "auto", display: "inline-flex", gap: 4, alignItems: "center" }}>
            <input type="checkbox" checked={s.active} onChange={async (e) => { await api("/api/crm/webhooks", "PATCH", { id: s.id, active: e.target.checked }); void load(); }} /> Active
          </label>
        </div>
      ))}
      <div style={{ display: "flex", gap: 10, alignItems: "flex-end", flexWrap: "wrap", marginTop: 12 }}>
        <div><label className="label">Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div style={{ minWidth: 320, flex: 1 }}><label className="label">URL</label><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://billing.dealeraddendums.com/api/v1/crm-webhook" /></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", height: 36 }}>
          {EVENTS.map((ev) => (
            <label key={ev} style={{ display: "inline-flex", gap: 4, alignItems: "center", fontSize: 12 }}>
              <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} /> {ev}
            </label>
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={async () => {
          const r = await api("/api/crm/webhooks", "POST", { name, url, events });
          if (!r.ok) setErr(r.error!); else { setErr(null); setUrl(""); void load(); }
        }}>Add subscriber</button>
        {err && <span style={{ fontSize: 12, color: "var(--error)" }}>{err}</span>}
      </div>
      {deliveries.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <p className="label">Recent deliveries</p>
          {deliveries.map((d) => (
            <div key={d.id} style={{ fontSize: 12, display: "flex", gap: 10, padding: "3px 0", color: d.status === "failed" ? "var(--error)" : "var(--text-secondary)" }}>
              <span style={{ width: 160 }}>{new Date(d.created_at).toLocaleString()}</span>
              <span style={{ width: 180 }}>{d.event}</span>
              <span style={{ width: 80 }}>{d.status}</span>
              <span>{d.attempts} attempt{d.attempts === 1 ? "" : "s"}{d.last_status_code ? ` · HTTP ${d.last_status_code}` : ""}{d.last_error ? ` · ${d.last_error.slice(0, 80)}` : ""}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
