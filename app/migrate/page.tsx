import { Suspense } from "react";
import MigrateFlow from "@/components/MigrateFlow";

export const metadata = { title: "Migrate to DA Platform 5.0" };

// Public, no auth — the dealer arrives from the emailed OTP invite link
// (/migrate?invite=token). The 8-digit code (typed by the human) gates access
// to their staged data; nothing is created or changed until the final Confirm.
export default function MigratePage() {
  return (
    <div style={{ minHeight: "100vh", background: "#f5f6f7", fontFamily: "Roboto, Arial, sans-serif", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "32px 16px" }}>
      <Suspense fallback={null}>
        <MigrateFlow />
      </Suspense>
    </div>
  );
}
