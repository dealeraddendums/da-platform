import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "Get the App — DA Platform" };

const APP_STORE_URL = "https://apps.apple.com/us/app/dealeraddendums-5-0/id6788451484";

const FEATURES: Array<[string, string]> = [
  ["Scan a VIN", "Barcode, QR, or text scan — and jump straight to the vehicle."],
  ["Browse your live inventory", "Search and filter the same inventory you see here."],
  ["Build the addendum on the spot", "Add or remove products right from the lot."],
  ["Print Now", "AirPrint the finished addendum straight from your phone."],
  ["Print Later", "Queue vehicles on the lot, then batch-print the saved addendums at your desk printer."],
  ["Your existing login", "Sign in with your DealerAddendums account — all roles, including group store-switching."],
];

export default function GetTheAppPage() {
  return (
    <div>
      <PageHeader
        title="Get the App"
        subtitle="DealerAddendums 5.0 for iPhone — print addendums from the lot."
      />
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* Features card */}
        <div className="card" style={{ padding: 24, flex: "1 1 380px", maxWidth: 560 }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "#2a2b3c", margin: "0 0 6px" }}>
            Print addendums from the lot with your iPhone
          </h2>
          <p style={{ fontSize: 13, color: "#78828c", margin: "0 0 18px" }}>
            Everything you need to walk the lot: scan, build, and print without going back to a desk.
          </p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 14 }}>
            {FEATURES.map(([title, body]) => (
              <li key={title} style={{ display: "flex", gap: 10 }}>
                <span aria-hidden style={{ color: "#1976d2", fontWeight: 700, flexShrink: 0, lineHeight: "20px" }}>✓</span>
                <span style={{ fontSize: 14, lineHeight: 1.5, color: "#33363d" }}>
                  <strong>{title}</strong> — {body}
                </span>
              </li>
            ))}
          </ul>
          <p style={{ fontSize: 12, color: "#78828c", margin: "18px 0 0" }}>
            Requires an iPhone or iPad on iOS 16 or later.
          </p>
        </div>

        {/* Download card */}
        <div className="card" style={{ padding: 24, flex: "0 1 320px", textAlign: "center" }}>
          <p style={{ fontSize: 12, fontWeight: 700, color: "#78828c", textTransform: "uppercase", letterSpacing: ".05em", margin: "0 0 14px" }}>
            Download
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/app-store-qr.png"
            alt="QR code linking to DealerAddendums 5.0 on the App Store"
            width={220}
            height={220}
            style={{ display: "block", margin: "0 auto", border: "1px solid #e0e0e0", borderRadius: 8 }}
          />
          <p style={{ fontSize: 13, color: "#55595c", margin: "10px 0 20px" }}>Scan with your iPhone camera</p>
          <a href={APP_STORE_URL} target="_blank" rel="noopener noreferrer" aria-label="Download on the App Store">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/images/app-store-badge.svg" alt="Download on the App Store" style={{ height: 48, display: "inline-block" }} />
          </a>
        </div>
      </div>
    </div>
  );
}
