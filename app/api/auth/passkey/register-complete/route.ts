import { NextRequest, NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const userId = session.user.id;

  let body: { credential: RegistrationResponseJSON; friendlyName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  const { data: challengeRow } = await admin
    .from("passkey_challenges")
    .select("challenge, expires_at")
    .eq("user_id", userId)
    .single<{ challenge: string; expires_at: string }>();

  if (!challengeRow) {
    return NextResponse.json({ error: "Challenge not found. Please try again." }, { status: 400 });
  }

  if (new Date(challengeRow.expires_at) < new Date()) {
    await admin.from("passkey_challenges").delete().eq("user_id", userId);
    return NextResponse.json({ error: "Challenge expired. Please try again." }, { status: 400 });
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: process.env.RP_ORIGIN!,
      expectedRPID: process.env.RP_ID!,
      requireUserVerification: true,
    });
  } catch (e) {
    await admin.from("passkey_challenges").delete().eq("user_id", userId);
    return NextResponse.json(
      { error: "Verification failed: " + (e instanceof Error ? e.message : "Unknown") },
      { status: 400 }
    );
  }

  await admin.from("passkey_challenges").delete().eq("user_id", userId);

  if (!verification.verified || !verification.registrationInfo) {
    return NextResponse.json({ error: "Registration verification failed" }, { status: 400 });
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  await admin.from("passkeys").insert({
    user_id: userId,
    credential_id: credential.id,
    credential_public_key: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    device_type: credentialDeviceType,
    backed_up: credentialBackedUp,
    transports: credential.transports ?? [],
    friendly_name: body.friendlyName || "My Passkey",
  });

  return NextResponse.json({ success: true });
}
