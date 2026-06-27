export default function NotMigratedPage() {
  return (
    <div style={{
      minHeight: "100vh",
      background: "#3a6897",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      padding: "24px",
      fontFamily: "Roboto, sans-serif",
    }}>
      <div style={{
        background: "#fff",
        borderRadius: 8,
        border: "1px solid #e0e0e0",
        padding: "40px 48px",
        maxWidth: 480,
        width: "100%",
        textAlign: "center",
      }}>
        <div style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          background: "#2a2b3c",
          borderRadius: 6,
          padding: "6px 14px",
          marginBottom: 28,
        }}>
          <span style={{ color: "#ffa500", fontWeight: 700, fontSize: 13 }}>DA</span>
          <span style={{ color: "#fff", fontSize: 13 }}>DealerAddendums</span>
        </div>

        <h1 style={{ fontSize: 22, fontWeight: 700, color: "#2a2b3c", margin: "0 0 12px" }}>
          Your account is on Platform 4.0
        </h1>
        <p style={{ fontSize: 14, color: "#55595c", lineHeight: 1.6, margin: "0 0 28px" }}>
          Your dealership hasn&apos;t been moved to the new platform yet.
          Log in to your current account below, or contact DA to get on the migration list.
        </p>

        <a
          href="https://dealeraddendums.com/app/login"
          style={{
            display: "block",
            background: "#1976d2",
            color: "#fff",
            borderRadius: 4,
            padding: "11px 0",
            fontSize: 14,
            fontWeight: 600,
            textDecoration: "none",
            marginBottom: 16,
          }}
        >
          Log in to Platform 4.0
        </a>

        <a
          href="mailto:support@dealeraddendums.com?subject=Migration%20Request"
          style={{
            display: "block",
            border: "1px solid #e0e0e0",
            color: "#55595c",
            borderRadius: 4,
            padding: "11px 0",
            fontSize: 14,
            textDecoration: "none",
          }}
        >
          Request migration to Platform 5.0
        </a>
      </div>
    </div>
  );
}
