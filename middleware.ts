import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Skip auth enforcement if Supabase isn't configured yet
  if (!url || !key) {
    return NextResponse.next();
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { session },
  } = await supabase.auth.getSession();

  const { pathname } = request.nextUrl;
  const isAuthRoute = pathname === "/login" || pathname === "/signup";
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
    return NextResponse.redirect(redirectUrl);
  }

  // Force password reset: redirect to /reset-password before any other access
  if (session && session.user.app_metadata?.force_password_reset === true) {
    if (!isResetRoute && !isApiAuth) {
      return NextResponse.redirect(new URL("/reset-password", request.url));
    }
    return response;
  }

  // Redirect authenticated users (without forced reset) away from auth pages
  if (isAuthRoute && session) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  // Redirect authenticated users away from reset-password (not needed)
  if (isResetRoute && session) {
    return NextResponse.redirect(new URL("/dashboard", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
