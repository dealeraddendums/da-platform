import { NextRequest, NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { credential: AuthenticationResponseJSON; challengeId: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { credential, challengeId } = body;
  if (!credential || !challengeId) {
    return NextResponse.json({ error: "Missing credential or challengeId" }, { status: 400 });
  }

  const admin = createAdminSupabaseClient();

  // Look up the challenge
  const { data: challengeRow } = await admin
    .from("passkey_challenges")
    .select("challenge, expires_at")
    .eq("id", challengeId)
    .is("user_id", null)
    .single<{ challenge: string; expires_at: string }>();

  if (!challengeRow) {
    return NextResponse.json({ error: "Challenge not found. Please try again." }, { status: 400 });
  }

  if (new Date(challengeRow.expires_at) < new Date()) {
    await admin.from("passkey_challenges").delete().eq("id", challengeId);
    return NextResponse.json({ error: "Challenge expired. Please try again." }, { status: 400 });
  }

  // Find the passkey by credential ID
  const { data: passkey } = await admin
    .from("passkeys")
    .select("*")
    .eq("credential_id", credential.id)
    .single<{
      id: string;
      user_id: string;
      credential_id: string;
      credential_public_key: string;
      counter: number;
      device_type: string | null;
      backed_up: boolean;
      transports: string[] | null;
    }>();

  if (!passkey) {
    await admin.from("passkey_challenges").delete().eq("id", challengeId);
    return NextResponse.json({ error: "Passkey not found for this device" }, { status: 401 });
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: credential,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: process.env.RP_ORIGIN!,
      expectedRPID: process.env.RP_ID!,
      credential: {
        id: passkey.credential_id,
        publicKey: Buffer.from(passkey.credential_public_key, "base64url"),
        counter: passkey.counter,
        transports: (passkey.transports ?? []) as AuthenticatorTransport[],
      },
      requireUserVerification: true,
    });
  } catch (e) {
    await admin.from("passkey_challenges").delete().eq("id", challengeId);
    return NextResponse.json(
      { error: "Authentication failed: " + (e instanceof Error ? e.message : "Unknown") },
      { status: 400 }
    );
  }

  await admin.from("passkey_challenges").delete().eq("id", challengeId);

  if (!verification.verified) {
    return NextResponse.json({ error: "Authentication verification failed" }, { status: 401 });
  }

  // Update counter and last_used_at
  await admin
    .from("passkeys")
    .update({
      counter: verification.authenticationInfo.newCounter,
      last_used_at: new Date().toISOString(),
    })
    .eq("credential_id", passkey.credential_id);

  // Look up the user's email to create a session via magic link exchange
  const { data: { user }, error: userError } = await admin.auth.admin.getUserById(passkey.user_id);
  if (userError || !user?.email) {
    return NextResponse.json({ error: "User not found" }, { status: 500 });
  }

  // Generate a magic link token and immediately exchange it server-side for a session
  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.email,
  });

  if (linkError || !linkData) {
    return NextResponse.json({ error: linkError?.message ?? "Failed to create session" }, { status: 500 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  const verifyRes = await fetch(`${supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    }),
  });

  if (!verifyRes.ok) {
    const errText = await verifyRes.text().catch(() => "unknown");
    return NextResponse.json({ error: `Session creation failed: ${errText}` }, { status: 500 });
  }

  const sessionData = await verifyRes.json() as {
    access_token?: string;
    refresh_token?: string;
    error?: string;
    error_description?: string;
  };

  if (!sessionData.access_token || !sessionData.refresh_token) {
    return NextResponse.json(
      { error: sessionData.error_description ?? "No session returned" },
      { status: 500 }
    );
  }

  return NextResponse.json({
    access_token: sessionData.access_token,
    refresh_token: sessionData.refresh_token,
  });
}
