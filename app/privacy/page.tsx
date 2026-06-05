import LegalPage from "@/components/LegalPage";

export const metadata = {
  title: "Privacy Policy — DealerAddendums",
  description: "How DealerAddendums collects, uses, and protects your information.",
};

export default function PrivacyPage() {
  return <LegalPage file="privacy-policy.md" title="Privacy Policy" />;
}
