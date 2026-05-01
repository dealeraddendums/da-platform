import { NextRequest, NextResponse } from "next/server";
import { generateRegistrationOptions } from "@simplewebauthn/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export async function POST(_req: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const userId = session.user.id;
  const userEmail = session.user.email ?? "";

  const admin = createAdminSupabaseClient();

  const { data: existingRows } = await admin
    .from("passkeys")
    .select("credential_id, transports")
    .eq("user_id", userId);

  const { data: profile } = await admin
    .from("profiles")
    .select("full_name")
    .eq("id", userId)
    .single<{ full_name: string | null }>();

  // UUID → 16-byte Uint8Array (required by @simplewebauthn/server v10+)
  const userID = Buffer.from(userId.replace(/-/g, ""), "hex");

  const options = await generateRegistrationOptions({
    rpName: process.env.RP_NAME!,
    rpID: process.env.RP_ID!,
    userID,
    userName: userEmail,
    userDisplayName: profile?.full_name ?? userEmail,
    attestationType: "none",
    excludeCredentials: (existingRows ?? []).map((p) => ({
      id: p.credential_id,
      transports: (p.transports ?? []) as AuthenticatorTransport[],
    })),
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
  });

  // One active registration challenge per user at a time
  await admin.from("passkey_challenges").delete().eq("user_id", userId);
  await admin.from("passkey_challenges").insert({
    user_id: userId,
    challenge: options.challenge,
  });

  return NextResponse.json(options);
}
