import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ── Security headers ──────────────────────────────────────────────────────────

const SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Content-Security-Policy": [
    "default-src 'self'",
    // ProductFruits in-app tours + chat (docs/in-app-tours.md) load their script,
    // assets, web worker, and media from *.productfruits.com and talk to their
    // API/websocket — allow-listed across the directives below so the CSP doesn't
    // block the widget. The SDK spawns a Web Worker from app.productfruits.com to
    // load its chunks, so worker-src must allow the domain (blob: alone caused
    // ChunkLoadError); media-src is needed for its video tutorials.
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.productfruits.com",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.productfruits.com",
    "font-src 'self' https://fonts.gstatic.com https://*.productfruits.com",
    "img-src 'self' data: https: blob: https://*.productfruits.com",
    "media-src 'self' blob: https://*.productfruits.com",
    // S3 hosts: the global `*.s3.amazonaws.com` wildcard matches `bucket.s3.amazonaws.com`
    // but NOT the regional `bucket.s3.{region}.amazonaws.com` form, so each region the app
    // fetches/frames must be enumerated explicitly. Buckets in play: dealer-addendums
    // (us-west-1 — print output PDFs); new-addendum-backgrounds / new-infosheet-backgrounds /
    // new-infobox-images / new-dealer-logos / addendum-product-images (us-east-1).
    "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.s3.amazonaws.com https://s3.amazonaws.com https://*.s3.us-west-1.amazonaws.com https://*.s3.us-east-1.amazonaws.com https://xpsshipper.com https://api.anthropic.com https://api.qrserver.com https://api.mapbox.com https://events.mapbox.com https://*.productfruits.com wss://*.productfruits.com",
    "worker-src 'self' blob: https://*.productfruits.com",
    "frame-src 'self' blob: https://etl2.dealeraddendums.com https://*.s3.amazonaws.com https://s3.amazonaws.com https://*.s3.us-west-1.amazonaws.com https://*.s3.us-east-1.amazonaws.com https://*.productfruits.com",
    "object-src blob:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

// Public HTML widget endpoints are embedded on dealer sites (including via
// <iframe>), so they must NOT send X-Frame-Options: DENY / frame-ancestors
// 'none' — else the DNS cutover would break any iframe-based install. Narrower
// than EXTERNAL_API_PREFIXES: only the two HTML widget routes, not the JSON APIs.
// Both the /api routes AND the legacy root paths (rewritten to /api in
// next.config) must skip X-Frame-Options: DENY so an iframe-based install on a
// dealer site still works after the api.dealeraddendums.com cutover.
const EMBEDDABLE_WIDGET_PREFIXES = [
  "/api/generate-addendum",
  "/api/generate-button",
  "/generate-addendum",
  "/generate-button",
];
function isEmbeddableWidget(pathname: string): boolean {
  return EMBEDDABLE_WIDGET_PREFIXES.some((p) => pathname.startsWith(p));
}

function applySecurityHeaders(res: NextResponse, pathname?: string): void {
  const embeddable = !!pathname && isEmbeddableWidget(pathname);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (embeddable && k === "X-Frame-Options") continue; // allow framing on dealer sites
    if (embeddable && k === "Content-Security-Policy") {
      res.headers.set(k, v.replace("frame-ancestors 'none'", "frame-ancestors *"));
      continue;
    }
    res.headers.set(k, v);
  }
}

// ── CORS ──────────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS: string[] = [
  "https://app.dealeraddendums.com",
  "https://billing.dealeraddendums.com",
  process.env.NEXT_PUBLIC_APP_URL ?? "",
].filter(Boolean);

// Routes accessible from external/dealer websites — exempt from CORS restriction
const EXTERNAL_API_PREFIXES = [
  "/api/health",
  "/api/vehicle",
  "/api/dealeron",
  "/api/dealeronWS",
  "/api/dealerdotcom",
  "/api/dealerdotcomWS",
  "/api/generate-addendum",
  "/api/generate-button",
];

function isCorsExempt(pathname: string): boolean {
  return EXTERNAL_API_PREFIXES.some((p) => pathname.startsWith(p));
}

// An Origin is allowed when it's a known static origin, is SAME-ORIGIN (the app
// calling its own host), or is any *.addendums.ai white-label host. Same-origin
// covers every reseller domain served by this same app — <reseller>.addendums.ai
// and reseller vanity domains — without enumerating them. Without this, a browser
// POST from a white-label subdomain (Origin: https://<reseller>.addendums.ai) was
// 403'd before reaching the route, e.g. the OTP sign-in code silently never sent
// from an.addendums.ai (the frontend shows "we emailed a code" regardless).
function isAllowedOrigin(origin: string, host: string | null): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  try {
    const oHost = new URL(origin).host.toLowerCase();
    if (host && oHost === host.toLowerCase()) return true; // same-origin
    if (oHost === "addendums.ai" || oHost.endsWith(".addendums.ai")) return true; // white-label
  } catch {
    /* malformed Origin → not allowed */
  }
  return false;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

type RateLimitEntry = { count: number; resetAt: number };
const rateLimitStore = new Map<string, RateLimitEntry>();

function checkRateLimit(
  ip: string,
  bucket: string,
  limit: number,
  windowMs: number
): boolean {
  const key = `${ip}:${bucket}`;
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimitStore.set(key, { count: 1, resetAt: now + windowMs });
    return true; // allowed
  }
  if (entry.count >= limit) return false; // blocked
  entry.count++;
  return true; // allowed
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
}

// ── Middleware ────────────────────────────────────────────────────────────────

export async function middleware(request: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const { pathname } = request.nextUrl;
  const method = request.method;
  const ip = getClientIp(request);

  // ── Rate limiting on authentication endpoints ────────────────────────────────
  if (method === "POST") {
    if (pathname.startsWith("/api/auth/")) {
      if (!checkRateLimit(ip, "auth", 10, 60_000)) {
        const res = new NextResponse("Too Many Requests", { status: 429 });
        res.headers.set("Retry-After", "60");
        applySecurityHeaders(res, pathname);
        return res;
      }
    }
    if (pathname === "/api/invite/accept") {
      if (!checkRateLimit(ip, "invite_accept", 5, 3_600_000)) {
        const res = new NextResponse("Too Many Requests", { status: 429 });
        res.headers.set("Retry-After", "3600");
        applySecurityHeaders(res, pathname);
        return res;
      }
    }
  }

  // ── CORS restriction on API routes ───────────────────────────────────────────
  if (pathname.startsWith("/api/") && !isCorsExempt(pathname)) {
    const origin = request.headers.get("origin");
    const host = request.headers.get("host");

    // Handle OPTIONS preflight
    if (method === "OPTIONS") {
      const allowedOrigin =
        origin && isAllowedOrigin(origin, host) ? origin : "";
      const res = new NextResponse(null, { status: 204 });
      if (allowedOrigin) {
        res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
        res.headers.set(
          "Access-Control-Allow-Methods",
          "GET, POST, PATCH, DELETE, OPTIONS"
        );
        res.headers.set(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization, x-cron-secret, X-DA-Ghost-Token"
        );
        res.headers.set("Access-Control-Max-Age", "86400");
      }
      applySecurityHeaders(res, pathname);
      return res;
    }

    // Block cross-origin requests from unknown origins
    if (origin && !isAllowedOrigin(origin, host)) {
      const res = new NextResponse("Forbidden", { status: 403 });
      applySecurityHeaders(res, pathname);
      return res;
    }
  }

  // Skip Supabase auth if env isn't configured (local dev without .env.local)
  if (!supabaseUrl || !supabaseKey) {
    const res = NextResponse.next();
    applySecurityHeaders(res, pathname);
    return res;
  }

  // Expose the request path to server components (the dashboard layout reads
  // `x-da-pathname` via headers() to render nav/header by ROUTE — e.g. group
  // chrome on /groups* regardless of a persisted active_dealer_id — instead of
  // relying on entry-point handlers, which browser-back / direct URLs bypass).
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-da-pathname", pathname);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  const supabase = createServerClient(supabaseUrl, supabaseKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options: CookieOptions }[]
      ) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request: { headers: requestHeaders } });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  // /welcome is the 4.0-lockout landing page — public like /login, and a
  // visitor who already has a 5.0 session skips it straight to the dashboard.
  const isAuthRoute = pathname === "/login" || pathname === "/signup" || pathname === "/welcome";
  const isResetRoute = pathname === "/reset-password";
  const isApiAuth = pathname.startsWith("/api/auth/");
  const isProtected =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/dealers") ||
    pathname.startsWith("/groups") ||
    pathname.startsWith("/documents") ||
    pathname.startsWith("/admin") ||
    pathname.startsWith("/builder") ||
    pathname.startsWith("/vehicles") ||
    pathname.startsWith("/templates") ||
    pathname.startsWith("/settings") ||
    pathname.startsWith("/users") ||
    pathname.startsWith("/reports") ||
    pathname.startsWith("/billing") ||
    pathname === "/reset-password";

  // Redirect unauthenticated users away from protected routes
  if (isProtected && !session) {
    const redirectUrl = new URL("/login", request.url);
    redirectUrl.searchParams.set("next", pathname);
    const redirectRes = NextResponse.redirect(redirectUrl);
    applySecurityHeaders(redirectRes, pathname);
    return redirectRes;
  }

  // Force password reset: redirect to /reset-password before any other access
  const isImpersonating = request.cookies.get("da_impersonating")?.value === "1";
  if (
    session &&
    session.user.app_metadata?.force_password_reset === true &&
    !isImpersonating
  ) {
    if (!isResetRoute && !isApiAuth) {
      const redirectRes = NextResponse.redirect(
        new URL("/reset-password", request.url)
      );
      applySecurityHeaders(redirectRes, pathname);
      return redirectRes;
    }
    applySecurityHeaders(response, pathname);
    return response;
  }

  // Redirect authenticated users away from auth pages
  if (isAuthRoute && session) {
    const redirectRes = NextResponse.redirect(
      new URL("/dashboard", request.url)
    );
    applySecurityHeaders(redirectRes, pathname);
    return redirectRes;
  }

  // NOTE: /reset-password is deliberately reachable with a session — it doubles
  // as the voluntary change-password page (profile "Change Password →" link).
  // A previous session-bounce here sent every logged-in user to /dashboard,
  // which made that link a silent no-op for all roles. The forced-reset flow is
  // handled above (force_password_reset users are pinned TO this route);
  // unauthenticated visitors are pushed to /login by the isProtected branch.

  applySecurityHeaders(response, pathname);
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|html)$).*)",
  ],
};
