"use client";

// Company page → Activity: the unified crm_activities timeline, newest first,
// with type filter chips and the add-note box on top. Rows carry
// id="act-{id}" so the Summary card's sources can scroll to them.

import { useEffect, useMemo, useState } from "react";
import AddNoteForm from "@/components/crm/AddNoteForm";
import Timeline from "@/components/crm/Timeline";
import type { TimelineItem } from "@/lib/crm/queries";

const TYPES: [string, string][] = [
  ["call", "Calls"], ["email", "Email"], ["chat", "Chat"], ["note", "Notes"], ["task", "Tasks"],
  ["ticket", "Tickets"], ["feed_order", "Feeds"], ["status_change", "Status"], ["file", "Files"],
];

export default function ActivityCard({ companyId, items, staff, contactNames }: {
  companyId: string; items: TimelineItem[]; staff: Record<string, string>; contactNames: Record<string, string>;
}) {
  const [type, setType] = useState<string | null>(null);
  const present = useMemo(() => new Set(items.map((i) => i.type)), [items]);
  const shown = type ? items.filter((i) => i.type === type) : items;

  // A Summary source pointing at a filtered-out row: clear the filter, then scroll.
  useEffect(() => {
    const on = (e: Event) => {
      const id = (e as CustomEvent).detail?.id;
      setType(null);
      setTimeout(() => document.getElementById(`act-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50);
    };
    window.addEventListener("crm:activity-show-all", on);
    return () => window.removeEventListener("crm:activity-show-all", on);
  }, []);

  return (
    <section className="crm-card">
      <div className="crm-card-head" style={{ flexWrap: "wrap" }}>
        <h2>Activity</h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button type="button" className="crm-chip" aria-pressed={type === null} onClick={() => setType(null)}>All</button>
          {TYPES.filter(([k]) => present.has(k)).map(([k, label]) => (
            <button key={k} type="button" className="crm-chip" aria-pressed={type === k} onClick={() => setType(type === k ? null : k)}>{label}</button>
          ))}
        </div>
      </div>
      <AddNoteForm companyId={companyId} />
      <Timeline items={shown} staff={staff} contactNames={contactNames} anchors />
    </section>
  );
}
