import type { Metadata } from "next";

export const metadata: Metadata = { title: "Welcome to DA Platform 5.0" };

// This page is intentionally public — no auth required.
// It's the landing page after a dealer clicks the legacy upgrade link.
export default function MigrationWelcomePage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>;
}) {
  const dealerName  = typeof searchParams.dealer === "string"  ? searchParams.dealer  : null;
  const invitedStr  = typeof searchParams.invited === "string" ? searchParams.invited : null;
  const error       = typeof searchParams.error === "string"   ? searchParams.error   : null;
  const invited     = invitedStr ? parseInt(invitedStr, 10) : null;

  const isError = !!error;

  return (
    <div style={{
      minHeight: "100vh",
      background: "#f5f6f7",
      fontFamily: "Roboto, Arial, sans-serif",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px 16px",
    }}>
      <div style={{ maxWidth: 520, width: "100%" }}>

        {/* Header card */}
        <div style={{
          background: "#2a2b3c",
          borderRadius: "8px 8px 0 0",
          padding: "36px 40px",
          textAlign: "center",
        }}>
          <img
            src="https://new-infobox-images.s3.us-east-1.amazonaws.com/da-logo.png"
            alt="DA Platform"
            width={56}
            height={56}
            style={{ borderRadius: "50%", marginBottom: 16 }}
          />
          <div style={{ color: "#fff", fontSize: 22, fontWeight: 700, letterSpacing: "-0.02em" }}>
            DealerAddendums Platform 5.0
          </div>
        </div>

        {/* Body card */}
        <div style={{
          background: "#fff",
          border: "1px solid #e0e0e0",
          borderTop: "none",
          padding: "36px 40px",
        }}>
          {isError ? (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#333", marginBottom: 12 }}>
                Something went wrong
              </div>
              <p style={{ fontSize: 14, color: "#55595c", lineHeight: 1.7, marginBottom: 24 }}>
                {error === "invalid_token" && "This upgrade link is invalid or has expired. Please contact your dealer administrator."}
                {error === "missing_dealer" && "No dealer was specified in this link. Please contact your dealer administrator."}
                {error === "dealer_not_found" && "We couldn't locate your dealer account. Please contact support."}
                {!["invalid_token", "missing_dealer", "dealer_not_found"].includes(error ?? "") && "An unexpected error occurred. Please contact support."}
              </p>
              <p style={{ fontSize: 13, color: "#78828c", margin: 0 }}>
                Questions?{" "}
                <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2" }}>
                  Contact support
                </a>
              </p>
            </>
          ) : (
            <>
              <div style={{ fontSize: 20, fontWeight: 600, color: "#333", marginBottom: 12 }}>
                Welcome to DA Platform 5.0!
              </div>
              <p style={{ fontSize: 14, color: "#55595c", lineHeight: 1.7, marginBottom: 24 }}>
                {invited !== null && invited > 0 ? (
                  <>
                    We&apos;ve sent login invitations to{" "}
                    <strong>{invited} {invited === 1 ? "user" : "users"}</strong>
                    {dealerName ? <> at <strong>{dealerName}</strong></> : ""}.
                  </>
                ) : (
                  <>
                    Your account at{dealerName ? <> <strong>{dealerName}</strong></> : " your dealership"} has been upgraded.
                  </>
                )}
              </p>

              <div style={{
                background: "#f5f6f7",
                borderRadius: 6,
                padding: "20px 24px",
                marginBottom: 28,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: "0.06em", color: "#78828c", marginBottom: 14 }}>
                  Next steps
                </div>
                <div style={{ fontSize: 14, color: "#333", lineHeight: 1.7 }}>
                  <div style={{ marginBottom: 8 }}>📧 Check your email for a magic link to set up your account.</div>
                  <div style={{ marginBottom: 8 }}>🔐 Click the link to log in and set up Face ID or Touch ID.</div>
                  <div>🚀 You&apos;re all set — no password needed going forward.</div>
                </div>
              </div>

              <p style={{ fontSize: 13, color: "#78828c", margin: 0, textAlign: "center" as const }}>
                Questions? Contact{" "}
                <a href="mailto:support@dealeraddendums.com" style={{ color: "#1976d2" }}>
                  support@dealeraddendums.com
                </a>
              </p>
            </>
          )}
        </div>

        {/* Footer */}
        <div style={{
          background: "#f5f6f7",
          border: "1px solid #e0e0e0",
          borderTop: "none",
          borderRadius: "0 0 8px 8px",
          padding: "16px 40px",
          textAlign: "center" as const,
        }}>
          <span style={{ fontSize: 12, color: "#78828c" }}>
            DealerAddendums &middot; dealeraddendums.com
          </span>
        </div>

      </div>
    </div>
  );
}
