// Error → HTTP for the /api/crm/feeds routes.
import { NextResponse } from "next/server";
import { FeedOrderError } from "./orders";
import { TransitionError } from "./state";
import { SendError } from "../inbox-send";
import { GraphError } from "../graph";

export function feedErrorResponse(e: unknown): NextResponse {
  if (e instanceof FeedOrderError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof TransitionError) return NextResponse.json({ error: e.message }, { status: 409 });
  if (e instanceof SendError) return NextResponse.json({ error: e.message }, { status: e.status });
  if (e instanceof GraphError) return NextResponse.json({ error: `Microsoft 365: ${e.message}` }, { status: 502 });
  console.error("[crm-feeds]", e instanceof Error ? e.message : e);
  return NextResponse.json({ error: e instanceof Error ? e.message : "Something went wrong" }, { status: 500 });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
