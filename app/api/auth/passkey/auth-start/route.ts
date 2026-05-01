import { NextRequest, NextResponse } from "next/server";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const options = await generateAuthenticationOptions({
    rpID: process.env.RP_ID!,
    userVerification: "required",
    // No allowCredentials — discoverable credential flow (browser shows all passkeys for this site)
  });

  const admin = createAdminSupabaseClient();

  // Store challenge without user_id — we don't know the user yet
  const { data: challengeRow } = await admin
    .from("passkey_challenges")
    .insert({ user_id: null, challenge: options.challenge })
    .select("id")
    .single<{ id: string }>();

  // Return challenge options + the challenge row ID so auth-complete can look it up
  return NextResponse.json({ ...options, challengeId: challengeRow?.id });
}
