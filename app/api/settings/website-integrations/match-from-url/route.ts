export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { stylesToButtonCss, type ExtractedMatch } from "@/lib/button-css";

// "Match from URL" (2026-07-17): read the EXACT computed styles of a button on
// the dealer's live site and return equivalent CSS for the widget button —
// precise where the screenshot/vision generator has to guess (Pugmire: right
// color, wrong width/padding/font). Auth mirrors generate-css: any staff role
// except dealer_user; no dealer scoping needed (input is a public URL + button
// text, output is CSS text).
//
// The page fetch happens on da-pdf-service (it already carries Puppeteer);
// its /api/pdf/extract-styles endpoint owns the SSRF guards: http(s)-only,
// DNS-resolved private/loopback/link-local/metadata IP rejection on the URL
// AND every sub-request, 5-redirect cap, 20 MB / 25 s caps.

// Only the two widget selectors may be targeted — never caller-supplied
// selectors (they'd flow into a <style> block on dealer sites).
const TARGET_CLASSES = new Set([
  ".dealer-addendums__button__download-button",
  ".dealer-addendums__button__icon-button",
]);

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;
  if (claims.role === "dealer_user") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  let body: { url?: string; buttonText?: string; targetClass?: string };
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const url = (body.url ?? "").trim();
  const buttonText = (body.buttonText ?? "").trim();
  const targetClass = (body.targetClass ?? ".dealer-addendums__button__download-button").trim();

  if (!/^https?:\/\//i.test(url)) {
    return NextResponse.json({ error: "Enter the full page address (starting with http or https)." }, { status: 400 });
  }
  if (!buttonText || buttonText.length > 120) {
    return NextResponse.json({ error: "Enter the text of the button to match (up to 120 characters)." }, { status: 400 });
  }
  if (!TARGET_CLASSES.has(targetClass)) {
    return NextResponse.json({ error: "Unknown target" }, { status: 400 });
  }

  const serviceUrl = process.env.PDF_SERVICE_URL;
  const serviceKey = process.env.PDF_SERVICE_API_KEY;
  if (!serviceUrl || !serviceKey) {
    return NextResponse.json({ error: "Style matching is not available right now." }, { status: 503 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 35_000);
  let payload: { match?: ExtractedMatch; candidates?: unknown; error?: string };
  let status: number;
  try {
    const res = await fetch(`${serviceUrl}/api/pdf/extract-styles`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-Key": serviceKey },
      body: JSON.stringify({ url, buttonText }),
      signal: ctrl.signal,
    });
    status = res.status;
    payload = await res.json().catch(() => ({ error: "Bad response from extractor" }));
  } catch {
    return NextResponse.json({
      error: "We couldn't read that page — it may block automated visitors. Try the screenshot method instead.",
      fallback: "screenshot",
    }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }

  if (!payload.match) {
    // 404 = text not found; 422 = blocked/invalid URL — both get the friendly
    // fallback suggestion since the screenshot path always works.
    const msg = status === 404
      ? `We couldn't find a "${buttonText}" button on that page. Check the text, or try the screenshot method instead.`
      : "We couldn't read that page — it may block automated visitors. Try the screenshot method instead.";
    console.log(`[match-from-url] no match (${status}) for "${buttonText}" @ ${url}: ${payload.error ?? ""}`);
    return NextResponse.json({ error: msg, fallback: "screenshot" }, { status: 422 });
  }

  const css = stylesToButtonCss(payload.match, targetClass);
  console.log(`[match-from-url] matched <${payload.match.tag} class="${payload.match.className}"> for "${buttonText}" @ ${url} (fullWidth=${payload.match.fullWidth}); candidates=${JSON.stringify(payload.candidates ?? [])}`);
  return NextResponse.json({
    css,
    matched: {
      tag: payload.match.tag,
      className: payload.match.className,
      text: payload.match.text,
      fullWidth: payload.match.fullWidth,
    },
  });
}
