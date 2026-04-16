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
    role: claims.role,
    dealer_id: claims.dealer_id,
    user_id: claims.sub,
  });
}
