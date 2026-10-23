// DA-CRM tasks and tickets (the company page's Tasks & Tickets card).
// Tasks = things to do; tickets = things that need fixing. Creating one also
// writes a 'task' / 'ticket' activity on the timeline, which becomes the
// item's source_activity_id unless it came from another activity (a chat,
// call or email — then "Open chat to reply" etc. can take you back to it).
/* eslint-disable @typescript-eslint/no-explicit-any */

export type WorkKind = "task" | "ticket";
export const TASK_STATUSES = ["open", "done", "cancelled"] as const;
export const TICKET_STATUSES = ["open", "pending", "resolved", "closed"] as const;
export const TICKET_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validated insert/update fields from a request body. Pure (unit-tested). */
export function workPatch(kind: WorkKind, b: any, creating: boolean): { patch: Record<string, unknown> } | { error: string } {
  const patch: Record<string, unknown> = {};
  if (creating || "title" in b) {
    const t = typeof b?.title === "string" ? b.title.trim() : "";
    if (!t) return { error: "Title required" };
    patch.title = t.slice(0, 300);
  }
  if ("description" in (b ?? {})) patch.description = typeof b.description === "string" && b.description.trim() ? b.description.trim().slice(0, 10_000) : null;
  if ("assigned_staff_id" in (b ?? {})) {
    if (b.assigned_staff_id != null && b.assigned_staff_id !== "" && !UUID.test(String(b.assigned_staff_id))) return { error: "Bad assignee" };
    patch.assigned_staff_id = b.assigned_staff_id || null;
  }
  if (kind === "task" && "due_at" in (b ?? {})) {
    if (b.due_at && Number.isNaN(Date.parse(b.due_at))) return { error: "Bad due date" };
    patch.due_at = b.due_at ? new Date(b.due_at).toISOString() : null;
  }
  if (kind === "ticket" && "priority" in (b ?? {})) {
    if (!(TICKET_PRIORITIES as readonly string[]).includes(b.priority)) return { error: "Bad priority" };
    patch.priority = b.priority;
  }
  if ("status" in (b ?? {})) {
    const ok = (kind === "task" ? TASK_STATUSES : TICKET_STATUSES) as readonly string[];
    if (!ok.includes(b.status)) return { error: "Bad status" };
    patch.status = b.status;
    const closed = kind === "task" ? b.status !== "open" : b.status === "resolved" || b.status === "closed";
    patch[kind === "task" ? "completed_at" : "resolved_at"] = closed ? new Date().toISOString() : null;
  }
  return { patch };
}

export const TABLE: Record<WorkKind, string> = { task: "crm_tasks", ticket: "crm_tickets" };
