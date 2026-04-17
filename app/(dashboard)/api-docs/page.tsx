import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";

export const metadata = { title: "API Docs — DA Platform" };

type Method = "GET" | "POST" | "PATCH" | "DELETE";

type Endpoint = {
  method: Method;
  path: string;
  description: string;
  role: string;
};

type Section = {
  title: string;
  endpoints: Endpoint[];
};

const METHOD_COLORS: Record<Method, { bg: string; text: string }> = {
  GET:    { bg: "#e8f5e9", text: "#2e7d32" },
  POST:   { bg: "#e3f2fd", text: "#1565c0" },
  PATCH:  { bg: "#fff8e1", text: "#f57f17" },
  DELETE: { bg: "#ffebee", text: "#c62828" },
};

const NEW_PLATFORM_SECTIONS: Section[] = [
  {
    title: "Auth",
    endpoints: [
      { method: "GET",  path: "/api/auth/privilege",                    description: "Returns the current user's role, dealer_id, and group_id from JWT claims", role: "authenticated" },
      { method: "POST", path: "/api/auth/stop-impersonate",             description: "Ends an active impersonation session and restores the original admin identity", role: "authenticated" },
    ],
  },
  {
    title: "Admin — Users",
    endpoints: [
      { method: "GET",   path: "/api/admin/users",                      description: "List all users platform-wide; filterable by dealer_id and role", role: "super_admin" },
      { method: "GET",   path: "/api/admin/users/[id]",                 description: "Get a single user profile", role: "super_admin" },
      { method: "PATCH", path: "/api/admin/users/[id]",                 description: "Update user profile and sync changes to Supabase auth metadata", role: "super_admin" },
      { method: "POST",  path: "/api/admin/users/[id]/impersonate",     description: "Assume another user's identity for testing or support", role: "super_admin" },
    ],
  },
  {
    title: "Users",
    endpoints: [
      { method: "GET",    path: "/api/users",                           description: "List users belonging to the authenticated dealer", role: "dealer_admin+" },
      { method: "POST",   path: "/api/users",                           description: "Create a new sub-user for the authenticated dealer", role: "dealer_admin" },
      { method: "PATCH",  path: "/api/users/[id]",                      description: "Update a sub-user's profile (own dealer only)", role: "dealer_admin" },
      { method: "DELETE", path: "/api/users/[id]",                      description: "Delete a sub-user (own dealer only)", role: "dealer_admin" },
      { method: "POST",   path: "/api/users/[id]/reset-password",       description: "Send a Supabase password-reset email to a sub-user", role: "dealer_admin" },
    ],
  },
  {
    title: "Dealers",
    endpoints: [
      { method: "GET",    path: "/api/dealers",                         description: "List dealers; super_admin sees all, dealer_admin sees own, paginated with search", role: "authenticated" },
      { method: "POST",   path: "/api/dealers",                         description: "Create a new dealer record", role: "super_admin" },
      { method: "GET",    path: "/api/dealers/[id]",                    description: "Get a single dealer by UUID", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/dealers/[id]",                    description: "Update dealer profile (own dealer or super_admin)", role: "dealer_admin+" },
      { method: "DELETE", path: "/api/dealers/[id]",                    description: "Permanently delete a dealer record", role: "super_admin" },
    ],
  },
  {
    title: "Groups",
    endpoints: [
      { method: "GET",    path: "/api/groups",                          description: "List all groups; super_admin sees all, group_admin sees own", role: "super_admin / group_admin" },
      { method: "POST",   path: "/api/groups",                          description: "Create a new dealer group", role: "super_admin" },
      { method: "GET",    path: "/api/groups/[id]",                     description: "Get a single group by UUID", role: "super_admin / group_admin" },
      { method: "PATCH",  path: "/api/groups/[id]",                     description: "Update group profile", role: "super_admin / group_admin" },
      { method: "DELETE", path: "/api/groups/[id]",                     description: "Delete a group (dealers in group have group_id set to null)", role: "super_admin" },
      { method: "GET",    path: "/api/groups/[id]/dealers",             description: "List all dealers assigned to a group", role: "super_admin / group_admin" },
      { method: "POST",   path: "/api/groups/[id]/dealers",             description: "Assign a dealer to a group", role: "super_admin / group_admin" },
      { method: "DELETE", path: "/api/groups/[id]/dealers",             description: "Remove a dealer from a group", role: "super_admin / group_admin" },
    ],
  },
  {
    title: "Vehicle Inventory (Aurora — read-only)",
    endpoints: [
      { method: "GET", path: "/api/vehicles",     description: "List vehicles for a dealer; supports q, condition (new/used/cpo/all), status, page, per_page filters", role: "authenticated (scoped)" },
      { method: "GET", path: "/api/vehicles/[id]", description: "Get a single vehicle's full record including OPTIONS, DESCRIPTION, and all photos", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Settings (Phase 5)",
    endpoints: [
      { method: "GET",   path: "/api/settings", description: "Get dealer settings (ai_content_default, nudge margins, default template UUIDs); returns defaults if none saved", role: "dealer_admin+" },
      { method: "PATCH", path: "/api/settings", description: "Upsert dealer settings; super_admin / group_admin must pass ?dealer_id= param", role: "dealer_admin+" },
    ],
  },
  {
    title: "Templates (Phase 5)",
    endpoints: [
      { method: "GET",    path: "/api/templates",       description: "List all templates for a dealer, ordered by created_at desc", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/templates",       description: "Create a new addendum or infosheet template for a dealer", role: "dealer_admin+" },
      { method: "GET",    path: "/api/templates/[id]",  description: "Get a single template record", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/templates/[id]",  description: "Update template name, document_type, vehicle_types, template_json, or is_active", role: "dealer_admin+" },
      { method: "DELETE", path: "/api/templates/[id]",  description: "Permanently delete a template", role: "dealer_admin+" },
    ],
  },
];

export default async function ApiDocsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const { data: profile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", session.user.id)
    .single<{ role: string }>();

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role !== "super_admin") redirect("/dashboard");

  const totalEndpoints = NEW_PLATFORM_SECTIONS.reduce((n, s) => n + s.endpoints.length, 0);
  const legacyCount = 17;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-semibold" style={{ color: "var(--text-primary)" }}>
          API Documentation
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-muted)" }}>
          {totalEndpoints + legacyCount} total endpoints — {legacyCount} legacy (ported) + {totalEndpoints} new platform &mdash; super_admin access only
        </p>
      </div>

      {/* Legend */}
      <div className="card p-4 mb-6 flex flex-wrap gap-4 items-center">
        <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Method</span>
        {(["GET", "POST", "PATCH", "DELETE"] as Method[]).map((m) => (
          <span
            key={m}
            className="text-xs font-bold px-2 py-0.5 rounded"
            style={{ background: METHOD_COLORS[m].bg, color: METHOD_COLORS[m].text }}
          >
            {m}
          </span>
        ))}
        <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
          All endpoints require a valid Supabase JWT session cookie
        </span>
      </div>

      {/* Legacy APIs section */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Legacy APIs (Ported from api.dealeraddendums.com)
          </h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #a5d6a7" }}
          >
            17 endpoints
          </span>
        </div>

        {[
          {
            title: "Vehicle & VIN",
            endpoints: [
              { method: "GET" as Method, path: "/api/vehicle",                             description: "Vehicle lookup: feature=button checks for addendum PDF; feature=pricing returns MSRP + options (requires stock); feature=both returns both", role: "public" },
              { method: "GET" as Method, path: "/api/decode-vin",                          description: "Decode VIN via NHTSA vPIC; returns make, model, year, body class, and all decoded fields", role: "authenticated" },
              { method: "GET" as Method, path: "/api/generate-button/[vin]/[theme]",       description: "Returns HTML download-button embed for a VIN; empty string if no PDF exists. Optional: ?text=", role: "public (embed widget)" },
              { method: "GET" as Method, path: "/api/generate-addendum/[vin]/[theme]",     description: "Returns HTML addendum embed. Optional: ?feature=pricing|both&stock=&text=", role: "public (embed widget)" },
            ],
          },
          {
            title: "Dealer Data (key→JWT)",
            endpoints: [
              { method: "GET" as Method, path: "/api/search",                              description: "Search dealer_inventory by VIN; optionally scoped to dealership_id", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getalldealerships",                   description: "List all dealerships from dealer_dim; super_admin gets all, others get own", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getallvehicles",                      description: "List all active vehicles for a dealer from dealer_inventory; pass ?dealer= for admin override", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getdealeroptions",                    description: "List addendum options for the dealer's vehicles from addendum_data; optional ?from=&to= date filter", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getdealerdefaults",                   description: "List default addendum items for the dealer from addendum_defaults", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getvehicleoptions",                   description: "List addendum options for a specific VIN from addendum_data; requires ?vin=", role: "authenticated" },
              { method: "GET" as Method, path: "/api/countoptions",                        description: "Count how many times a named option was added for the dealer; requires ?option=; optional ?from=&to=", role: "authenticated" },
              { method: "GET" as Method, path: "/api/countgroupoptions",                   description: "Count option appearances across all dealers in the same group; requires ?option=; optional ?from=&to=", role: "authenticated" },
              { method: "GET" as Method, path: "/api/getdealernames",                      description: "List dealer_dim IDs and names; super_admin gets all, others get own", role: "authenticated" },
            ],
          },
          {
            title: "DMS Integrations (public webhooks)",
            endpoints: [
              { method: "GET" as Method, path: "/api/dealerdotcom",                        description: "Dealer.com DMS: returns vehicle pricing (MSRP, INTERNET_PRICE) + addendum options for a VIN+stock", role: "public" },
              { method: "GET" as Method, path: "/api/dealerdotcomWS",                      description: "Dealer.com DMS: returns wholesale price as plain text string (e.g. $1234.56)", role: "public" },
              { method: "GET" as Method, path: "/api/dealeron",                            description: "DealerOn DMS: returns vehicle pricing + addendum options (trimmed option schema)", role: "public" },
              { method: "GET" as Method, path: "/api/dealeronWS",                          description: "DealerOn DMS: returns wholesale price as plain text string", role: "public" },
            ],
          },
        ].map((section) => (
          <div key={section.title} className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}>
              {section.title}
            </p>
            <div className="card" style={{ overflow: "hidden" }}>
              {section.endpoints.map((ep, i) => (
                <div
                  key={`${ep.method}-${ep.path}`}
                  className="flex items-start gap-4 px-4 py-3"
                  style={{
                    borderBottom: i < section.endpoints.length - 1 ? "1px solid var(--border)" : "none",
                    background: i % 2 === 0 ? "var(--bg-surface)" : "var(--bg-subtle)",
                  }}
                >
                  <span
                    className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0 mt-0.5"
                    style={{ background: METHOD_COLORS[ep.method].bg, color: METHOD_COLORS[ep.method].text, minWidth: 52, textAlign: "center" }}
                  >
                    {ep.method}
                  </span>
                  <code className="text-sm flex-shrink-0" style={{ color: "var(--text-primary)", fontFamily: "monospace", minWidth: 280 }}>
                    {ep.path}
                  </code>
                  <span className="text-sm flex-1" style={{ color: "var(--text-secondary)" }}>
                    {ep.description}
                  </span>
                  <span
                    className="text-xs px-2 py-0.5 rounded flex-shrink-0 mt-0.5"
                    style={{ background: "var(--bg-subtle)", color: "var(--text-muted)", border: "1px solid var(--border)", whiteSpace: "nowrap" }}
                  >
                    {ep.role}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* New Platform APIs */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            New Platform APIs
          </h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: "#e3f2fd", color: "#1565c0", border: "1px solid #90caf9" }}
          >
            {totalEndpoints} endpoints
          </span>
        </div>

        <div className="flex flex-col gap-6">
          {NEW_PLATFORM_SECTIONS.map((section) => (
            <div key={section.title}>
              <p
                className="text-xs font-semibold uppercase tracking-wider mb-3"
                style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
              >
                {section.title}
              </p>
              <div
                className="card"
                style={{ overflow: "hidden" }}
              >
                {section.endpoints.map((ep, i) => (
                  <div
                    key={`${ep.method}-${ep.path}-${i}`}
                    className="flex items-start gap-4 px-4 py-3"
                    style={{
                      borderBottom: i < section.endpoints.length - 1 ? "1px solid var(--border)" : "none",
                      background: i % 2 === 0 ? "var(--bg-surface)" : "var(--bg-subtle)",
                    }}
                  >
                    <span
                      className="text-xs font-bold px-2 py-0.5 rounded flex-shrink-0 mt-0.5"
                      style={{
                        background: METHOD_COLORS[ep.method].bg,
                        color: METHOD_COLORS[ep.method].text,
                        minWidth: 52,
                        textAlign: "center",
                      }}
                    >
                      {ep.method}
                    </span>
                    <code
                      className="text-sm flex-shrink-0"
                      style={{ color: "var(--text-primary)", fontFamily: "monospace", minWidth: 280 }}
                    >
                      {ep.path}
                    </code>
                    <span
                      className="text-sm flex-1"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {ep.description}
                    </span>
                    <span
                      className="text-xs px-2 py-0.5 rounded flex-shrink-0 mt-0.5"
                      style={{
                        background: "var(--bg-subtle)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {ep.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
