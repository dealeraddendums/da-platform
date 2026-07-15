"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { UserRole } from "@/lib/db";
import { useBrand } from "@/contexts/Brand";
import pkg from "../package.json";

type NavItem = {
  label: string;
  href: string;
  icon: React.ReactNode;
  disabled?: boolean;
  roles: UserRole[];
  itemStyle?: React.CSSProperties;
};

type NavSection = {
  section: string;
  roles: UserRole[];
};

type NavEntry = NavItem | NavSection;

const nav: NavEntry[] = [
  // ── Main ─────────────────────────────────────────────────────────────────────
  {
    label: "Dashboard",
    href: "/dashboard",
    roles: ["super_admin", "group_admin", "group_user", "dealer_admin", "dealer_user"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    label: "Dealers",
    href: "/dealers",
    roles: ["super_admin", "group_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    label: "Groups",
    href: "/groups",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    label: "My Group",
    href: "/groups",
    roles: ["group_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
        <path d="M16 3.13a4 4 0 0 1 0 7.75" />
      </svg>
    ),
  },
  {
    label: "My Profile",
    href: "/staff-profile",
    roles: ["group_admin", "group_user"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  // Regional manager (group_user): a scoped dealer list (their tagged subset).
  {
    label: "My Dealers",
    href: "/dealers",
    roles: ["group_user"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    label: "Users",
    href: "/users",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    label: "My Profile",
    href: "/staff-profile",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  // ── Dealer-facing items ───────────────────────────────────────────────────────
  {
    label: "Products",
    href: "/options",
    roles: ["dealer_admin", "dealer_user"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="8" y1="6" x2="21" y2="6" />
        <line x1="8" y1="12" x2="21" y2="12" />
        <line x1="8" y1="18" x2="21" y2="18" />
        <line x1="3" y1="6" x2="3.01" y2="6" strokeWidth="3" strokeLinecap="round" />
        <line x1="3" y1="12" x2="3.01" y2="12" strokeWidth="3" strokeLinecap="round" />
        <line x1="3" y1="18" x2="3.01" y2="18" strokeWidth="3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "Builder",
    href: "/builder",
    roles: ["dealer_admin", "dealer_user", "group_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
  },
  {
    label: "Users",
    href: "/users",
    roles: ["dealer_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    ),
  },
  {
    label: "My Profile",
    href: "/profile",
    roles: ["dealer_admin", "dealer_user", "dealer_restricted"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
      </svg>
    ),
  },
  {
    label: "Print Settings",
    href: "/settings",
    roles: ["dealer_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    ),
  },
  // Divider sits between Print Settings and Order Supplies per the
  // documented dealer-role nav: Dashboard → Products → Builder → Users →
  // My Profile → Print Settings → [divider] → Order Supplies → Help.
  {
    section: "",
    roles: ["dealer_admin", "dealer_user", "dealer_restricted"],
  },
  {
    label: "Order Supplies",
    href: "/profile?tab=labels",
    roles: ["dealer_admin", "dealer_user", "dealer_restricted"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="9" cy="21" r="1" />
        <circle cx="20" cy="21" r="1" />
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
      </svg>
    ),
  },
  {
    label: "Help",
    href: "/help",
    roles: ["dealer_admin", "dealer_user", "dealer_restricted", "group_admin", "group_user"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
      </svg>
    ),
  },
  // ── Help CMS (support team — super_admin) ─────────────────────────────────────
  {
    label: "Help Center",
    href: "/help/manage",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </svg>
    ),
  },
  // ── Feeds section ─────────────────────────────────────────────────────────────
  {
    section: "Feeds",
    roles: ["super_admin"],
  },
  {
    label: "FTP Server",
    href: "/admin/ftp-server",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" strokeWidth="3" strokeLinecap="round" />
        <line x1="6" y1="18" x2="6.01" y2="18" strokeWidth="3" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    label: "ETL Server",
    href: "/etl-server",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="4" y1="21" x2="4" y2="14" />
        <line x1="4" y1="10" x2="4" y2="3" />
        <line x1="12" y1="21" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="3" />
        <line x1="20" y1="21" x2="20" y2="16" />
        <line x1="20" y1="12" x2="20" y2="3" />
        <line x1="1" y1="14" x2="7" y2="14" />
        <line x1="9" y1="8" x2="15" y2="8" />
        <line x1="17" y1="16" x2="23" y2="16" />
      </svg>
    ),
  },
  {
    label: "CDK Dealers",
    href: "/admin/cdk-dealers",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
      </svg>
    ),
  },
  {
    label: "Tekion Dealers",
    href: "/admin/tekion-dealers",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <line x1="3" y1="9" x2="21" y2="9" />
        <line x1="9" y1="21" x2="9" y2="9" />
      </svg>
    ),
  },
  // ── Admin section ─────────────────────────────────────────────────────────────
  {
    section: "Admin",
    roles: ["super_admin"],
  },
  {
    label: "Migration",
    href: "/migration",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M5 12h14" />
        <path d="M13 6l6 6-6 6" />
        <path d="M3 5v14" />
      </svg>
    ),
  },
  {
    label: "QA Dashboard",
    href: "/qa",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M9 11l3 3 8-8" />
        <path d="M20 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    label: "QA Test Runner",
    href: "/qa/test",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="9 11 12 14 22 4" />
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
      </svg>
    ),
  },
  {
    label: "Reports",
    href: "/reports",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <line x1="18" y1="20" x2="18" y2="10" />
        <line x1="12" y1="20" x2="12" y2="4" />
        <line x1="6" y1="20" x2="6" y2="14" />
        <line x1="2" y1="20" x2="22" y2="20" />
      </svg>
    ),
  },
  {
    label: "Billing",
    href: "/billing",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="1" y="4" width="22" height="16" rx="2" ry="2" />
        <line x1="1" y1="10" x2="23" y2="10" />
      </svg>
    ),
  },
  {
    label: "Business Intelligence",
    href: "/admin/bi",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M3 3v18h18" />
        <path d="M7 14l3-4 4 3 5-7" />
      </svg>
    ),
  },
  {
    label: "Decoder",
    href: "/admin/decoder",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
        <line x1="11" y1="8" x2="11" y2="14" />
        <line x1="8" y1="11" x2="14" y2="11" />
      </svg>
    ),
  },
  {
    label: "SuperAdmin Builder",
    href: "/starter-layouts",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="12" y1="18" x2="12" y2="12" />
        <line x1="9" y1="15" x2="15" y2="15" />
      </svg>
    ),
  },
  {
    label: "Buyer's Guide PDFs",
    href: "/system-admin/buyers-guide",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <polyline points="10 17 12 19 16 15" />
      </svg>
    ),
  },
  {
    label: "Feeds",
    href: "/admin/feeds",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 11a9 9 0 0 1 9 9" />
        <path d="M4 4a16 16 0 0 1 16 16" />
        <circle cx="5" cy="19" r="1" />
      </svg>
    ),
  },
  {
    label: "Banners",
    href: "/admin/banners",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M4 4h16v12H5.2L4 17.5V4z" />
        <line x1="8" y1="9" x2="16" y2="9" />
        <line x1="8" y1="12.5" x2="13" y2="12.5" />
      </svg>
    ),
  },
  {
    label: "Image Library",
    href: "/admin/image-library",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    ),
  },
  // ── Documents section ─────────────────────────────────────────────────────────
  {
    section: "Documents",
    roles: ["super_admin"],
  },
  {
    label: "API Docs",
    href: "/api-docs",
    roles: ["super_admin"],
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <polyline points="16 18 22 12 16 6" />
        <polyline points="8 6 2 12 8 18" />
      </svg>
    ),
  },
];

export default function Sidebar({ role = "dealer_user", hideBuilder = false, showUpgrade = false }: { role?: UserRole | "group_user"; hideBuilder?: boolean; showUpgrade?: boolean }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tabParam = searchParams.get("tab");
  const brand = useBrand();
  // hideBuilder is set when the dealer's group has taken over template
  // management (dealers.group_controls_templates = true) — Builder is then
  // off-limits for dealer roles. group_admin / super_admin always see it.
  const visibleNav = nav
    .filter((entry) => entry.roles.includes(role as UserRole))
    .filter((entry) => !(hideBuilder && "href" in entry && entry.href === "/builder"));

  function getIsActive(item: NavItem): boolean {
    if (item.disabled) return false;
    if (item.href.includes("?")) {
      const [hrefPath, hrefSearch] = item.href.split("?");
      const hrefTab = new URLSearchParams(hrefSearch).get("tab");
      return pathname === hrefPath && tabParam === hrefTab;
    }
    // /profile without ?tab=labels should not highlight when labels tab is active
    if (item.href === "/profile" && tabParam === "labels") return false;
    return pathname === item.href || pathname.startsWith(item.href + "/");
  }

  return (
    <aside
      className="flex-shrink-0 flex flex-col h-full"
      style={{ width: 220, background: "var(--navy)" }}
    >
      {/* Logo — host-resolved brand (reseller logo + name on a branded host). */}
      <div
        className="flex items-center gap-2 px-4 h-14 flex-shrink-0"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}
      >
        <img
          src={brand.logoUrl}
          alt={brand.displayName}
          width={36}
          height={36}
          style={{ borderRadius: "50%", flexShrink: 0, objectFit: "contain", background: "rgba(255,255,255,0.06)" }}
        />
        <span
          className="font-semibold text-sm truncate"
          style={{ color: "var(--text-inverse)" }}
        >
          {brand.displayName}
        </span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-2 overflow-y-auto">
        {/* Upgrade CTA — non-paying dealer_admin only; links to the Billing tab.
            Styled as a yellow button, deliberately distinct from nav-item rows. */}
        {showUpgrade && (
          <Link
            href="/profile?tab=billing&upgrade=1"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              margin: "6px 12px 12px",
              padding: "10px 12px",
              background: "#ffa500",
              color: "#2a2b3c",
              fontWeight: 700,
              fontSize: 14,
              borderRadius: 6,
              textDecoration: "none",
              boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="12" y1="19" x2="12" y2="5" />
              <polyline points="5 12 12 5 19 12" />
            </svg>
            <span>Upgrade Now</span>
          </Link>
        )}
        {visibleNav.map((entry, i) => {
          if ("section" in entry) {
            return (
              <div
                key={`section-${i}`}
                style={{
                  padding: "16px 16px 4px",
                  fontSize: 10,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: ".06em",
                  color: "rgba(255,255,255,0.35)",
                  borderTop: "1px solid rgba(255,255,255,0.08)",
                  marginTop: 4,
                }}
              >
                {entry.section}
              </div>
            );
          }
          const item = entry as NavItem;
          const isActive = getIsActive(item);
          return item.disabled ? (
            <div key={item.href} className="nav-item disabled" style={item.itemStyle}>
              {item.icon}
              <span>{item.label}</span>
            </div>
          ) : (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-item${isActive ? " active" : ""}`}
              style={item.itemStyle}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Phase label */}
      <div
        className="px-4 py-3 text-xs flex-shrink-0"
        style={{
          color: "rgba(255,255,255,0.3)",
          borderTop: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        v{pkg.version}
      </div>
    </aside>
  );
}
