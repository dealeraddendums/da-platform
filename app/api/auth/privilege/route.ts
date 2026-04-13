import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";

/**
 * GET /api/auth/privilege
 * Returns the authenticated user's role and dealer_id from JWT claims.
 */
export async function GET(): Promise<NextResponse> {
  const { claims, error } = await requireAuth();
  if (error) return error;

  return NextResponse.json({
    user_type: claims.user_type,
    dealer_id: claims.dealer_id,
    user_id: claims.sub,
    ...(claims.impersonating_dealer_id
      ? { impersonating_dealer_id: claims.impersonating_dealer_id }
      : {}),
  });
}
