"use client";

// Client-side tab strip wrapping the dealer detail page. Two tabs:
//   Profile  — the existing DealerProfileCard with its own inline edits
//   Billing  — the new DealerBillingTab
//
// Visual style matches the role-tab strip on /users (white background,
// dark #333 text, orange #ffa500 active-underline) instead of the
// dark-on-dark GroupOptionsPanel style, because the dealer detail page
// sits on the light card background.

import { useState, type ReactNode } from "react";

type TabKey = "profile" | "users" | "billing";

export default function DealerDetailTabs({
  profile,
  users,
  billing,
}: {
  profile: ReactNode;
  users: ReactNode;
  billing: ReactNode;
}) {
  const [tab, setTab] = useState<TabKey>("profile");

  const tabs: { key: TabKey; label: string }[] = [
    { key: "profile", label: "Profile" },
    { key: "users",   label: "Users" },
    { key: "billing", label: "Billing" },
  ];

  return (
    <div>
      <div
        style={{
          display: "flex",
          gap: 0,
          marginBottom: 16,
          background: "#fff",
          padding: "0 4px",
          borderBottom: "2px solid #e0e0e0",
          flexWrap: "wrap",
          borderRadius: 6,
        }}
      >
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: "10px 18px",
              fontSize: 13,
              fontWeight: tab === t.key ? 600 : 500,
              background: "none",
              border: "none",
              borderBottom: tab === t.key ? "2px solid #ffa500" : "2px solid transparent",
              color: "#333",
              cursor: "pointer",
              marginBottom: -2,
              whiteSpace: "nowrap",
              fontFamily: "inherit",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "profile" && profile}
      {tab === "users"   && users}
      {tab === "billing" && billing}
    </div>
  );
}
