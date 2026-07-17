import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminSupabaseClient } from "@/lib/db";
import { resolveSessionProfile } from "@/lib/profile-session";
import { PageHeader } from "@/components/PageHeader";

export const metadata = { title: "API Docs — DA Platform" };

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

type Endpoint = {
  method: Method;
  path: string;
  description: string;
  role: string;
};

type Section = {
  title: string;
  note?: string;
  endpoints: Endpoint[];
};

const METHOD_COLORS: Record<Method, { bg: string; text: string }> = {
  GET:    { bg: "#e8f5e9", text: "#2e7d32" },
  POST:   { bg: "#e3f2fd", text: "#1565c0" },
  PATCH:  { bg: "#fff8e1", text: "#f57f17" },
  PUT:    { bg: "#fff3e0", text: "#e65100" },
  DELETE: { bg: "#ffebee", text: "#c62828" },
};

// ── Widget & public API routes ──────────────────────────────────────────────────
// These are split across two services. The DA Platform copies are the internal,
// session-auth'd data routes used by the dashboard + legacy compatibility. The
// external widget API (root paths) is served by the dedicated da-api-service
// microservice at api.dealeraddendums.com — NOT this app.
const PUBLIC_API_SECTIONS: Section[] = [
  {
    title: "DA Platform — Widget & Vehicle Routes",
    note: "Internal routes on this app (app.dealeraddendums.com). Most require a valid session.",
    endpoints: [
      { method: "GET", path: "/api/vehicle",            description: "Widget backend: feature=button checks for a PDF; feature=pricing returns MSRP + options (needs stock); feature=both returns both", role: "public (widget backend)" },
      { method: "GET", path: "/api/decode-vin",         description: "Decode a VIN via NHTSA vPIC; returns make, model, year, body class and all decoded fields", role: "authenticated" },
      { method: "GET", path: "/api/search",             description: "Search dealer_vehicles by VIN; optionally scoped to dealership_id", role: "authenticated" },
      { method: "GET", path: "/api/getalldealerships",  description: "List dealerships from Supabase dealers; super_admin gets all, others get own", role: "authenticated" },
      { method: "GET", path: "/api/getallvehicles",     description: "List a dealer's active vehicles; ?dealer= admin override", role: "authenticated" },
      { method: "GET", path: "/api/getdealeroptions",   description: "List printed addendum options for the dealer from addendum_data; optional ?from=&to=", role: "authenticated" },
      { method: "GET", path: "/api/getdealerdefaults",  description: "List the dealer's default addendum items from addendum_library", role: "authenticated" },
      { method: "GET", path: "/api/getvehicleoptions",  description: "List printed addendum options for a specific VIN from addendum_data; requires ?vin=", role: "authenticated" },
      { method: "GET", path: "/api/countoptions",       description: "Count how often a named option was printed for the dealer; requires ?option=; optional ?from=&to=", role: "authenticated" },
      { method: "GET", path: "/api/countgroupoptions",  description: "Count option-print appearances across all dealers in the same group; requires ?option=", role: "authenticated" },
      { method: "GET", path: "/api/getdealernames",     description: "List dealer IDs + names from Supabase dealers; super_admin gets all, others get own", role: "authenticated" },
    ],
  },
  {
    title: "da-api-service (api.dealeraddendums.com)",
    note: "Served from the dedicated public API microservice — NOT this app. Deployed separately (repo: da-api-service). CloudFront-fronted, read-only Supabase. Key-gated routes authenticate against the Supabase key_owners store.",
    endpoints: [
      { method: "GET", path: "/generate-addendum/:vin/:theme", description: "Embed widget HTML: pricing block + download button. Optional ?feature=pricing|button|both|icon&stock=&text=&dealer= (dealer = your inventory dealer ID — scopes the VIN lookup when the same VIN exists under two dealers and selects your button styling; unknown value returns an empty body)", role: "public (widget)" },
      { method: "GET", path: "/generate-button/:vin/:theme",   description: "Embed widget HTML: download button only (?feature=icon for the compact icon button). Optional ?text=&dealer= (dealer = your inventory dealer ID — selects your button label/styling directly; unknown value returns an empty body)", role: "public (widget)" },
      { method: "GET", path: "/dealerdotcom",                  description: "Dealer.com DMS: vehicle pricing (MSRP, INTERNET_PRICE) + addendum options for a VIN+stock", role: "public" },
      { method: "GET", path: "/dealerdotcomWS",                description: "Dealer.com DMS: options total as a plain price string", role: "public" },
      { method: "GET", path: "/dealeron",                      description: "DealerOn DMS: vehicle pricing + addendum options", role: "public" },
      { method: "GET", path: "/dealeronWS",                    description: "DealerOn DMS: options total as a plain price string", role: "public" },
      { method: "GET", path: "/search",                        description: "Single vehicle by VIN (raw legacy shape). Reseller keys resolve by VIN alone", role: "API key (key_owners)" },
      { method: "GET", path: "/getvehicleoptions",             description: "Options array for a VIN (raw legacy shape); requires ?vin=", role: "API key (key_owners)" },
      { method: "GET", path: "/getdealerdefaults",             description: "Dealer default-option templates (legacy addendum_defaults shape)", role: "API key (key_owners)" },
    ],
  },
];

// ── New platform APIs (the full dashboard/admin surface on this app) ─────────────
const NEW_PLATFORM_SECTIONS: Section[] = [
  {
    title: "Auth & Passkeys",
    endpoints: [
      { method: "GET",    path: "/api/auth/privilege",                 description: "Current user's role, dealer_id, group_id and scope tags from JWT claims", role: "authenticated" },
      { method: "POST",   path: "/api/auth/stop-impersonate",          description: "End an impersonation session and restore the original admin identity", role: "authenticated" },
      { method: "POST",   path: "/api/auth/otp-login",                 description: "Email one-time-code login (invite / white-label flow)", role: "public (auth flow)" },
      { method: "POST",   path: "/api/auth/clear-force-reset",         description: "Clear a forced-password-reset flag after the user resets", role: "public (auth flow)" },
      { method: "GET",    path: "/api/auth/passkey/list",              description: "List the current user's registered passkeys", role: "authenticated" },
      { method: "POST",   path: "/api/auth/passkey/register-start",    description: "Begin WebAuthn passkey registration (issue challenge)", role: "public (auth flow)" },
      { method: "POST",   path: "/api/auth/passkey/register-complete", description: "Complete WebAuthn passkey registration", role: "public (auth flow)" },
      { method: "POST",   path: "/api/auth/passkey/auth-start",        description: "Begin WebAuthn passkey login (issue challenge)", role: "public (auth flow)" },
      { method: "POST",   path: "/api/auth/passkey/auth-complete",     description: "Complete WebAuthn passkey login and issue a session", role: "public (auth flow)" },
      { method: "PATCH",  path: "/api/auth/passkey/[id]",              description: "Rename a registered passkey", role: "authenticated" },
      { method: "DELETE", path: "/api/auth/passkey/[id]",              description: "Delete a registered passkey", role: "authenticated" },
    ],
  },
  {
    title: "Admin — Users & Impersonation",
    endpoints: [
      { method: "GET",   path: "/api/admin/users",                 description: "List all users platform-wide; filter by dealer_id and role", role: "super_admin" },
      { method: "GET",   path: "/api/admin/users/[id]",            description: "Get a single user profile", role: "super_admin" },
      { method: "PATCH", path: "/api/admin/users/[id]",            description: "Update a user profile and sync to Supabase auth metadata", role: "super_admin" },
      { method: "POST",  path: "/api/admin/users/[id]/impersonate", description: "Assume a user's identity for support/testing", role: "super_admin" },
      { method: "POST",  path: "/api/admin/impersonate",           description: "Start impersonating a dealer user", role: "super_admin" },
      { method: "POST",  path: "/api/admin/impersonate-group",     description: "Start impersonating a group admin", role: "super_admin" },
      { method: "POST",  path: "/api/admin/ghost",                 description: "Enter a dealer account as a scoped ghost session", role: "super_admin" },
      { method: "POST",  path: "/api/admin/ghost/exit",            description: "Exit an active ghost session", role: "authenticated" },
      { method: "POST",  path: "/api/admin/create-dealer-user",    description: "Create a dealer's initial admin user", role: "super_admin" },
    ],
  },
  {
    title: "Admin — Banners",
    endpoints: [
      { method: "GET",    path: "/api/admin/banners",      description: "List platform banners", role: "super_admin" },
      { method: "POST",   path: "/api/admin/banners",      description: "Create a platform banner", role: "super_admin" },
      { method: "PATCH",  path: "/api/admin/banners/[id]", description: "Update a banner (message, style, active window, audience)", role: "super_admin" },
      { method: "DELETE", path: "/api/admin/banners/[id]", description: "Delete a banner", role: "super_admin" },
    ],
  },
  {
    title: "Admin — Feeds (CDK / Tekion)",
    endpoints: [
      { method: "GET",    path: "/api/admin/cdk-dealers",             description: "List CDK feed dealers", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk-dealers",             description: "Add a CDK feed dealer", role: "super_admin" },
      { method: "PATCH",  path: "/api/admin/cdk-dealers/[id]",        description: "Update a CDK feed dealer", role: "super_admin" },
      { method: "DELETE", path: "/api/admin/cdk-dealers/[id]",        description: "Remove a CDK feed dealer", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk-dealers/bulk-delete", description: "Bulk-remove CDK feed dealers", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk/import",              description: "Import a CDK dealer list", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk/bulk-update",         description: "Start a CDK bulk feed-setting update job", role: "super_admin" },
      { method: "GET",    path: "/api/admin/cdk/bulk-update/status",  description: "Poll a CDK bulk-update job's status", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk/bulk-update/status",  description: "Advance/refresh a CDK bulk-update job", role: "super_admin" },
      { method: "POST",   path: "/api/admin/cdk/test",                description: "Test a CDK feed connection", role: "super_admin" },
      { method: "GET",    path: "/api/admin/tekion-dealers",         description: "List Tekion feed dealers", role: "super_admin" },
      { method: "POST",   path: "/api/admin/tekion-dealers",         description: "Add a Tekion feed dealer", role: "super_admin" },
      { method: "PATCH",  path: "/api/admin/tekion-dealers/[id]",    description: "Update a Tekion feed dealer", role: "super_admin" },
      { method: "DELETE", path: "/api/admin/tekion-dealers/[id]",    description: "Remove a Tekion feed dealer", role: "super_admin" },
    ],
  },
  {
    title: "Admin — FTP Server",
    endpoints: [
      { method: "GET",    path: "/api/admin/ftp/users",             description: "List FTP feed users", role: "super_admin" },
      { method: "POST",   path: "/api/admin/ftp/add-user",          description: "Create an FTP feed user", role: "super_admin" },
      { method: "DELETE", path: "/api/admin/ftp/users/[username]",  description: "Delete an FTP user", role: "super_admin" },
      { method: "POST",   path: "/api/admin/ftp/change-password",   description: "Reset an FTP user's password", role: "super_admin" },
      { method: "GET",    path: "/api/admin/ftp/files/[username]",  description: "List an FTP user's files", role: "super_admin" },
      { method: "POST",   path: "/api/admin/ftp/files/[username]",  description: "Upload a file to an FTP user's directory", role: "super_admin" },
      { method: "DELETE", path: "/api/admin/ftp/files/[username]",  description: "Delete a file from an FTP user's directory", role: "super_admin" },
      { method: "GET",    path: "/api/admin/ftp/download/[username]", description: "Download a file from an FTP user's directory", role: "super_admin" },
      { method: "GET",    path: "/api/admin/ftp/notes/[username]",  description: "Read ops notes on an FTP user", role: "super_admin" },
      { method: "PUT",    path: "/api/admin/ftp/notes/[username]",  description: "Update ops notes on an FTP user", role: "super_admin" },
    ],
  },
  {
    title: "Admin — Vehicle Reference & Decodes",
    endpoints: [
      { method: "GET",    path: "/api/admin/nhtsa-overrides",      description: "List NHTSA decode overrides", role: "authenticated (admin)" },
      { method: "POST",   path: "/api/admin/nhtsa-overrides",      description: "Create an NHTSA decode override", role: "authenticated (admin)" },
      { method: "PATCH",  path: "/api/admin/nhtsa-overrides/[id]", description: "Update an NHTSA decode override", role: "authenticated (admin)" },
      { method: "DELETE", path: "/api/admin/nhtsa-overrides/[id]", description: "Delete an NHTSA decode override", role: "authenticated (admin)" },
      { method: "GET",    path: "/api/admin/nhtsa-sync",           description: "Inspect NHTSA reference sync state", role: "authenticated (admin)" },
      { method: "POST",   path: "/api/admin/nhtsa-sync",           description: "Trigger an NHTSA reference sync", role: "authenticated (admin)" },
      { method: "GET",    path: "/api/admin/flagged-decodes",      description: "List VINs with flagged / failed decodes", role: "authenticated (admin)" },
      { method: "GET",    path: "/api/admin/vehicle-archive",      description: "Query archived vehicles", role: "super_admin" },
      { method: "POST",   path: "/api/admin/vehicle-archive",      description: "Archive / restore vehicles", role: "super_admin" },
      { method: "POST",   path: "/api/admin/import-legacy",        description: "Import a legacy dealer's data on demand", role: "authenticated (admin)" },
      { method: "GET",    path: "/api/admin/settings",             description: "Read platform-level settings", role: "authenticated (admin)" },
    ],
  },
  {
    title: "Admin — Business Intelligence",
    endpoints: [
      { method: "GET",  path: "/api/admin/bi",        description: "Business-intelligence dashboard metrics", role: "super_admin" },
      { method: "GET",  path: "/api/admin/bi/export", description: "Export BI metrics (CSV/Excel)", role: "super_admin" },
      { method: "POST", path: "/api/admin/bi/email",  description: "Email a BI report", role: "super_admin" },
    ],
  },
  {
    title: "Admin — Platform Image Library",
    endpoints: [
      { method: "GET",    path: "/api/admin/image-library/[bucket]",   description: "List platform library images in a bucket", role: "authenticated (admin)" },
      { method: "DELETE", path: "/api/admin/image-library/[bucket]",   description: "Delete a platform library image", role: "authenticated (admin)" },
      { method: "PATCH",  path: "/api/admin/image-library/meta/[id]",  description: "Update platform library image metadata", role: "authenticated (admin)" },
      { method: "POST",   path: "/api/admin/image-library/upload",     description: "Upload a platform library image", role: "authenticated (admin)" },
    ],
  },
  {
    title: "Cron Jobs",
    note: "Invoked by EasyCron with a shared CRON_SECRET; not user-facing.",
    endpoints: [
      { method: "POST", path: "/api/cron/archive-downgraded",       description: "Archive dealers past the 60-day downgrade grace", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/archive-vehicles",         description: "Archive stale / sold vehicles", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/backup-supabase",          description: "Nightly Supabase backup", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/chromedata-usage-report",  description: "ChromeData API usage report", role: "super_admin / cron" },
      { method: "POST", path: "/api/cron/harvest-vin-trims",        description: "Harvest VIN trim data into the reference set", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/purge-old-pdfs",           description: "Purge expired PDFs from the S3 bucket", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/qa-summary",               description: "Daily QA summary email", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/sync-hubspot-computed",    description: "Refresh computed HubSpot fields + re-evaluate lifecycle", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/sync-vehicle-reference",   description: "Sync make/model/trim reference tables", role: "cron (secret)" },
      { method: "POST", path: "/api/cron/sync-xps-tracking",        description: "Sync XPS shipment tracking", role: "cron (secret)" },
    ],
  },
  {
    title: "Users",
    endpoints: [
      { method: "GET",    path: "/api/users",                     description: "List users for the active dealer", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/users",                     description: "Create a sub-user for the active dealer", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/users/[id]",                description: "Update a sub-user's profile", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/users/[id]",                description: "Delete a sub-user", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/users/[id]/reset-password", description: "Send a password-reset email to a sub-user", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/users/invite-all-staff",    description: "Invite all of a dealer's un-invited staff at once", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "Dealers",
    endpoints: [
      { method: "GET",    path: "/api/dealers",                            description: "List dealers (super_admin all; dealer/group scoped); paginated + search", role: "authenticated" },
      { method: "POST",   path: "/api/dealers",                            description: "Create a dealer record", role: "super_admin" },
      { method: "GET",    path: "/api/dealers/[id]",                       description: "Get a dealer by UUID", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/dealers/[id]",                       description: "Update a dealer profile", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/dealers/[id]",                       description: "Permanently delete a dealer record", role: "super_admin" },
      { method: "GET",    path: "/api/dealers/[id]/delete-preview",        description: "Preview the cascade before deleting a dealer", role: "super_admin" },
      { method: "POST",   path: "/api/dealers/[id]/inventory-dealer-id",   description: "Change inventory_dealer_id and cascade to dealer_id + dependent tables", role: "super_admin" },
      { method: "GET",    path: "/api/dealers/[id]/corporate-products",    description: "List corporate/group-pushed products for a dealer", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/dealers/[id]/clear-print-history",   description: "Clear a dealer's print history (paginated/chunked)", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/dealers/[id]/logo",                  description: "Get a dealer's logo", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/dealers/[id]/logo",                  description: "Upload a dealer's logo", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/dealers/[id]/logo",                  description: "Remove a dealer's logo", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/dealers/[id]/users",                 description: "List a dealer's users", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/dealers/[id]/users",                 description: "Create a user for a dealer", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/dealers/[id]/users/[userId]",        description: "Update a dealer user", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/dealers/[id]/users/[userId]",        description: "Remove a dealer user", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/dealers/[id]/invitations/[invId]",   description: "Resend a dealer user invitation", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/dealers/[id]/invitations/[invId]",   description: "Revoke a pending dealer user invitation", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "Groups",
    endpoints: [
      { method: "GET",    path: "/api/groups",                              description: "List groups; super_admin all, group_admin own", role: "super_admin / group_admin" },
      { method: "POST",   path: "/api/groups",                              description: "Create a dealer group", role: "super_admin" },
      { method: "GET",    path: "/api/groups/[id]",                         description: "Get a group by UUID", role: "super_admin / group_admin" },
      { method: "PATCH",  path: "/api/groups/[id]",                         description: "Update a group profile", role: "super_admin / group_admin" },
      { method: "DELETE", path: "/api/groups/[id]",                         description: "Delete a group (member dealers' group_id set null)", role: "super_admin" },
      { method: "GET",    path: "/api/groups/[id]/delete-preview",          description: "Preview the cascade before deleting a group", role: "super_admin" },
      { method: "GET",    path: "/api/groups/[id]/dealers",                 description: "List a group's member dealers", role: "super_admin / group_admin" },
      { method: "POST",   path: "/api/groups/[id]/dealers",                 description: "Assign a dealer to a group", role: "super_admin / group_admin" },
      { method: "DELETE", path: "/api/groups/[id]/dealers",                 description: "Remove a dealer from a group", role: "super_admin / group_admin" },
      { method: "PATCH",  path: "/api/groups/[id]/dealers/[dealerId]",      description: "Update a group-dealer assignment (e.g. bill-to)", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/groups/[id]/images",                  description: "List the group image library", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/groups/[id]/images",                  description: "Upload a group library image", role: "group_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/groups/[id]/images",                  description: "Update a group image", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/groups/[id]/images",                  description: "Delete a group image", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/groups/[id]/option-assignments",      description: "List group-option → dealer assignments", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/groups/[id]/option-assignments",      description: "Assign group options to dealers", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/groups/[id]/option-assignments",      description: "Unassign a group option", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/groups/[id]/template-assignments",    description: "List group-template → dealer assignments", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/groups/[id]/template-assignments",    description: "Assign group templates to dealers", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/groups/[id]/template-assignments",    description: "Unassign a group template", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/groups/[id]/users",                   description: "List group-level users", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/groups/[id]/users",                   description: "Create a group-level user", role: "group_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/groups/[id]/users/[userId]",          description: "Update a group user", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/groups/[id]/users/[userId]",          description: "Remove a group user", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/groups/[id]/invitations/[invId]",     description: "Resend a group user invitation", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/groups/[id]/invitations/[invId]",     description: "Revoke a pending group user invitation", role: "group_admin+ (scoped)" },
    ],
  },
  {
    title: "Groups — Tags",
    endpoints: [
      { method: "GET",  path: "/api/tags",              description: "List tags with dealer + group counts", role: "authenticated" },
      { method: "POST", path: "/api/tags",              description: "Create a tag (case-insensitive unique)", role: "super_admin / group_admin" },
      { method: "GET",  path: "/api/dealers/[id]/tags", description: "Get a dealer's tags", role: "dealer_admin+ (scoped)" },
      { method: "PUT",  path: "/api/dealers/[id]/tags", description: "Set a dealer's tags", role: "dealer_admin+ (scoped)" },
      { method: "GET",  path: "/api/groups/[id]/tags",  description: "Get a group's tags", role: "group_admin+ (scoped)" },
      { method: "PUT",  path: "/api/groups/[id]/tags",  description: "Set a group's tags", role: "group_admin+ (scoped)" },
      { method: "GET",  path: "/api/users/[id]/tags",   description: "Get a group_user's scope tags (regional manager)", role: "super_admin" },
      { method: "PUT",  path: "/api/users/[id]/tags",   description: "Set a group_user's scope tags (regional manager)", role: "super_admin" },
    ],
  },
  {
    title: "Group Config (Disclaimers / Options / Templates)",
    endpoints: [
      { method: "GET",    path: "/api/group-disclaimers/[groupId]",                 description: "List a group's disclaimers", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/group-disclaimers/[groupId]",                 description: "Create a group disclaimer", role: "group_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/group-disclaimers/[groupId]/[disclaimerId]",  description: "Update a group disclaimer", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/group-disclaimers/[groupId]/[disclaimerId]",  description: "Delete a group disclaimer", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/group-options/[groupId]",                     description: "List a group's shared products", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/group-options/[groupId]",                     description: "Create a group-level product", role: "group_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/group-options/[groupId]/[optionId]",          description: "Update a group option", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/group-options/[groupId]/[optionId]",          description: "Delete a group option", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/group-templates/[groupId]",                   description: "List a group's templates", role: "group_admin+ (scoped)" },
      { method: "POST",   path: "/api/group-templates/[groupId]",                   description: "Create a group template", role: "group_admin+ (scoped)" },
      { method: "GET",    path: "/api/group-templates/[groupId]/[templateId]",      description: "Get a group template", role: "group_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/group-templates/[groupId]/[templateId]",      description: "Update a group template", role: "group_admin+ (scoped)" },
      { method: "DELETE", path: "/api/group-templates/[groupId]/[templateId]",      description: "Delete a group template", role: "group_admin+ (scoped)" },
    ],
  },
  {
    title: "Vehicle Inventory",
    endpoints: [
      { method: "GET",    path: "/api/vehicles",                    description: "List a dealer's vehicles (q, condition, status, paging) from dealer_vehicles", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/vehicles/[id]",               description: "Get a vehicle by UUID", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/vehicles/decode",             description: "Decode a VIN for the add-vehicle form", role: "authenticated" },
      { method: "GET",    path: "/api/vehicles/makes",              description: "Reference lookup: vehicle makes", role: "authenticated" },
      { method: "GET",    path: "/api/vehicles/models",             description: "Reference lookup: models for a make/year", role: "authenticated" },
      { method: "GET",    path: "/api/vehicles/trims",              description: "Reference lookup: trims", role: "authenticated" },
      { method: "GET",    path: "/api/vehicles/fuel-types",         description: "Reference lookup: fuel types", role: "authenticated" },
      { method: "GET",    path: "/api/dealer-vehicles",             description: "List manually-managed dealer vehicles", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/dealer-vehicles",             description: "Create a manual dealer vehicle", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/dealer-vehicles/[id]",        description: "Get a manual dealer vehicle", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/dealer-vehicles/[id]",        description: "Update a manual dealer vehicle", role: "authenticated (scoped)" },
      { method: "DELETE", path: "/api/dealer-vehicles/[id]",        description: "Delete a manual dealer vehicle", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/dealer-vehicles/[id]/history", description: "A vehicle's print / edit history", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/dealer-vehicles/bulk-delete", description: "Bulk-delete dealer vehicles", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/dealer-vehicles/import",      description: "Import vehicles (CSV / feed)", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Products / Options",
    endpoints: [
      { method: "GET",    path: "/api/options/[vehicleId]",                        description: "List a vehicle's addendum options", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/options/[vehicleId]",                        description: "Replace a vehicle's addendum options", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/options/[vehicleId]/add",                    description: "Add an option to a vehicle", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/options/[vehicleId]/[optionId]",             description: "Update a vehicle option", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/options/[vehicleId]/[optionId]",             description: "Remove a vehicle option", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/options/[vehicleId]/reorder",                description: "Reorder a vehicle's options", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/options/[vehicleId]/dismiss-group-option",   description: "Dismiss a group-pushed option on a vehicle", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/options/[vehicleId]/dismiss-group-option",   description: "Restore a dismissed group option", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/options/library",                            description: "The dealer's saved option library", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/addendum-library",                           description: "List the dealer's default-option library items", role: "dealer_admin+ (scoped)" },
      { method: "POST",   path: "/api/addendum-library",                           description: "Create a default-option library item", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/addendum-library/[id]",                      description: "Update a library item", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/addendum-library/[id]",                      description: "Delete a library item", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/addendum-library/reorder",                   description: "Reorder library items", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/option-images",                             description: "List option images", role: "authenticated" },
      { method: "POST",   path: "/api/option-images/upload",                      description: "Upload an option image", role: "authenticated" },
      { method: "POST",   path: "/api/upload-image",                              description: "Upload a product / description image", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/custom-sizes",                              description: "List custom paper sizes", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/custom-sizes",                              description: "Create a custom paper size", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/custom-sizes/[id]",                         description: "Update a custom size", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/custom-sizes/[id]",                         description: "Delete a custom size", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/disclaimers",                              description: "List the dealer's disclaimers", role: "authenticated (scoped)" },
      { method: "GET",    path: "/api/image-library",                            description: "List scoped Builder images (platform / group / dealer)", role: "authenticated (scoped)" },
      { method: "PATCH",  path: "/api/image-library",                            description: "Update a Builder image", role: "authenticated (scoped)" },
      { method: "DELETE", path: "/api/image-library",                            description: "Delete a Builder image", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/image-library/upload",                     description: "Upload a scoped Builder image", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Settings",
    endpoints: [
      { method: "GET",   path: "/api/settings",                       description: "Get dealer settings (AI toggle, nudge margins, default template UUIDs)", role: "dealer_admin+ (scoped)" },
      { method: "PATCH", path: "/api/settings",                       description: "Upsert dealer settings; admins pass ?dealer_id=", role: "dealer_admin+ (scoped)" },
      { method: "GET",   path: "/api/settings/permissions",           description: "Get a dealer's feature permissions", role: "authenticated (scoped)" },
      { method: "PATCH", path: "/api/settings/permissions",           description: "Update a dealer's feature permissions", role: "authenticated (scoped)" },
      { method: "GET",   path: "/api/settings/website-integrations",  description: "Get dealer website-integration config (widget / DMS)", role: "dealer_admin+ (scoped)" },
      { method: "PATCH", path: "/api/settings/website-integrations",  description: "Update dealer website-integration config", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "Templates",
    endpoints: [
      { method: "GET",    path: "/api/templates",      description: "List a dealer's templates (newest first)", role: "authenticated (scoped)" },
      { method: "POST",   path: "/api/templates",      description: "Create an addendum / infosheet template", role: "dealer_admin+ (scoped)" },
      { method: "GET",    path: "/api/templates/[id]", description: "Get a template", role: "dealer_admin+ (scoped)" },
      { method: "PATCH",  path: "/api/templates/[id]", description: "Update a template (name, type, JSON, is_active)", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/templates/[id]", description: "Delete a template", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "Starter Templates",
    endpoints: [
      { method: "GET",    path: "/api/starter-templates",      description: "List platform starter layouts (blank + starters)", role: "authenticated" },
      { method: "POST",   path: "/api/starter-templates",      description: "Create a starter layout", role: "super_admin" },
      { method: "GET",    path: "/api/starter-templates/[id]", description: "Get a starter layout", role: "authenticated" },
      { method: "PATCH",  path: "/api/starter-templates/[id]", description: "Update a starter layout", role: "super_admin" },
      { method: "DELETE", path: "/api/starter-templates/[id]", description: "Delete a starter layout", role: "super_admin" },
    ],
  },
  {
    title: "PDF Generation",
    note: "Render calls proxy to the da-pdf-service microservice; clients poll the status route.",
    endpoints: [
      { method: "POST", path: "/api/pdf/generate",              description: "Generate a single addendum / infosheet PDF (→ da-pdf-service)", role: "dealer_admin+ (scoped)" },
      { method: "POST", path: "/api/pdf/bulk",                  description: "Generate a merged bulk PDF for many vehicles (→ da-pdf-service)", role: "authenticated (scoped)" },
      { method: "POST", path: "/api/pdf/buyers-guide",          description: "Generate an FTC Buyer's Guide overlay PDF (→ da-pdf-service)", role: "authenticated (scoped)" },
      { method: "GET",  path: "/api/pdf/buyers-guide/preview",  description: "Preview a Buyer's Guide render", role: "public" },
      { method: "GET",  path: "/api/pdf/status/[jobId]",        description: "Poll a da-pdf-service job and return its signed URL (proxy)", role: "authenticated / API key" },
    ],
  },
  {
    title: "Printing",
    endpoints: [
      { method: "GET",  path: "/api/print/[vehicleId]",     description: "Get print options for a vehicle", role: "dealer_admin+ (scoped)" },
      { method: "POST", path: "/api/print/[vehicleId]",     description: "Stage a print for a vehicle", role: "dealer_admin+ (scoped)" },
      { method: "POST", path: "/api/print/bulk",            description: "Stage a bulk print run", role: "authenticated (scoped)" },
      { method: "POST", path: "/api/print/confirm",         description: "Confirm a staged print (records the distinct-vehicle count)", role: "dealer_admin+ (scoped)" },
      { method: "POST", path: "/api/print/clear-history",   description: "Clear staged / pending prints", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Billing",
    endpoints: [
      { method: "GET",   path: "/api/billing/me",                                     description: "The current dealer's billing summary", role: "authenticated (scoped)" },
      { method: "POST",  path: "/api/billing/me/close",                               description: "Self-close (downgrade to Free) at a $0 balance", role: "authenticated (scoped)" },
      { method: "PATCH", path: "/api/billing/me/subscription",                        description: "Change the dealer's own plan", role: "authenticated (scoped)" },
      { method: "GET",   path: "/api/billing/me/invoices/[invoiceId]/pdf",            description: "Download the dealer's own invoice PDF", role: "authenticated (scoped)" },
      { method: "GET",   path: "/api/billing/dealers/[dealerId]",                     description: "Admin: a dealer's billing summary", role: "authenticated (scoped)" },
      { method: "POST",  path: "/api/billing/dealers/[dealerId]/create-customer",     description: "Create a da-billing customer for a dealer", role: "dealer_admin+ (scoped)" },
      { method: "GET",   path: "/api/billing/dealers/[dealerId]/invoices/[invoiceId]/pdf", description: "Admin: a dealer's invoice PDF", role: "authenticated (scoped)" },
      { method: "GET",   path: "/api/billing/groups/[groupId]",                       description: "A group's billing summary", role: "authenticated (scoped)" },
      { method: "PUT",   path: "/api/billing/groups/[groupId]",                       description: "Update group billing settings", role: "authenticated (scoped)" },
      { method: "POST",  path: "/api/billing/groups/[groupId]/create-customer",       description: "Create a da-billing customer for a group", role: "authenticated (scoped)" },
      { method: "GET",   path: "/api/billing/groups/[groupId]/invoices/[invoiceId]/pdf", description: "A group's invoice PDF", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Buyer's Guide",
    endpoints: [
      { method: "GET",    path: "/api/system/buyers-guide-pdfs/[key]",       description: "Get a platform default Buyer's Guide PDF", role: "super_admin" },
      { method: "POST",   path: "/api/system/buyers-guide-pdfs/[key]",       description: "Upload a platform default Buyer's Guide PDF", role: "super_admin" },
      { method: "PUT",    path: "/api/system/buyers-guide-pdfs/[key]",       description: "Replace a platform default Buyer's Guide PDF", role: "super_admin" },
      { method: "GET",    path: "/api/dealers/[id]/buyers-guide-pdfs/[key]", description: "Get a dealer's custom Buyer's Guide PDF", role: "dealer_admin+ (scoped)" },
      { method: "PUT",    path: "/api/dealers/[id]/buyers-guide-pdfs/[key]", description: "Upload a dealer's custom Buyer's Guide PDF", role: "dealer_admin+ (scoped)" },
      { method: "DELETE", path: "/api/dealers/[id]/buyers-guide-pdfs/[key]", description: "Remove a dealer's custom Buyer's Guide PDF", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "HubSpot",
    endpoints: [
      { method: "POST", path: "/api/hubspot/sync", description: "Manually trigger a HubSpot Company/Contact upsert for a dealer or group", role: "authenticated" },
    ],
  },
  {
    title: "Banners (public)",
    endpoints: [
      { method: "GET", path: "/api/banners/active", description: "Active platform banners for the current host + role (public read)", role: "public" },
    ],
  },
  {
    title: "Invite / Onboarding",
    endpoints: [
      { method: "GET",  path: "/api/invite",          description: "List pending invitations for a dealer/group", role: "authenticated (scoped)" },
      { method: "POST", path: "/api/invite",          description: "Send a scoped-code user invitation", role: "authenticated (scoped)" },
      { method: "POST", path: "/api/invite/accept",   description: "Accept an invite (code or password) and consume the invitation", role: "public (auth flow)" },
      { method: "POST", path: "/api/invite/resend",   description: "Resend an invitation email", role: "public (auth flow)" },
      { method: "POST", path: "/api/onboard/resend",  description: "Resend a self-serve onboarding email", role: "public (auth flow)" },
      { method: "GET",  path: "/api/migrate/verify",  description: "Self-serve migration: look up an invite by OTP code", role: "public (auth flow)" },
      { method: "POST", path: "/api/migrate/verify",  description: "Self-serve migration: verify an OTP invite code", role: "public (auth flow)" },
      { method: "POST", path: "/api/migrate/confirm", description: "Self-serve migration: confirm and activate the account", role: "public (auth flow)" },
      { method: "GET",  path: "/api/migration/upgrade", description: "Public trial → paid upgrade landing data", role: "public" },
    ],
  },
  {
    title: "Migration Console",
    endpoints: [
      { method: "GET",   path: "/api/migration/readiness",         description: "Migration-readiness table (with group rollups)", role: "super_admin" },
      { method: "POST",  path: "/api/migration/claim-next",        description: "Claim the next N single-rooftop dealers to migrate", role: "super_admin" },
      { method: "POST",  path: "/api/migration/assign",            description: "Assign dealers to a migrator", role: "super_admin" },
      { method: "POST",  path: "/api/migration/stage-dealer",      description: "Stage a dealer for migration", role: "super_admin" },
      { method: "POST",  path: "/api/migration/invite-dealer",     description: "Send a single dealer migration invite", role: "super_admin" },
      { method: "POST",  path: "/api/migration/send-wave",         description: "Send a migration invite wave", role: "super_admin" },
      { method: "GET",   path: "/api/migration/waves",             description: "List migration waves + status", role: "super_admin" },
      { method: "POST",  path: "/api/migration/resend",            description: "Resend a migration invite", role: "super_admin" },
      { method: "POST",  path: "/api/migration/rollback",          description: "Roll back a dealer migration", role: "super_admin" },
      { method: "POST",  path: "/api/migration/activate-billing",  description: "Activate da-billing on a confirmed migration", role: "super_admin" },
      { method: "GET",   path: "/api/migration/billing-pending",   description: "List migrations pending billing activation", role: "super_admin" },
      { method: "POST",  path: "/api/migration/freshbooks-stopped", description: "Mark FreshBooks stopped for a migrated dealer", role: "super_admin" },
      { method: "PATCH", path: "/api/migration/template-confirmed", description: "Mark a dealer's template setup confirmed", role: "super_admin" },
    ],
  },
  {
    title: "Orders & Labels",
    endpoints: [
      { method: "GET",  path: "/api/orders/labels", description: "List label supply orders", role: "dealer_admin+ / API key" },
      { method: "POST", path: "/api/orders/labels", description: "Create a label supply order (XPS shipping)", role: "dealer_admin+ / API key" },
      { method: "POST", path: "/api/trial-labels",  description: "Request the free-trial label pack", role: "dealer_admin+ (scoped)" },
    ],
  },
  {
    title: "AI Content",
    endpoints: [
      { method: "GET",  path: "/api/ai-content",                     description: "Get AI-generated option content", role: "authenticated" },
      { method: "POST", path: "/api/ai-content/regenerate",          description: "Regenerate AI option content", role: "authenticated" },
      { method: "POST", path: "/api/ai-content/option-description",  description: "Generate an AI product description", role: "authenticated" },
    ],
  },
  {
    title: "Dashboard",
    endpoints: [
      { method: "GET", path: "/api/dashboard/recent-prints", description: "Recent prints for the dashboard", role: "authenticated (scoped)" },
      { method: "GET", path: "/api/dashboard/pdf-preview",   description: "Dashboard PDF preview", role: "authenticated (scoped)" },
      { method: "GET", path: "/api/chromedata/vehicle-photo", description: "Fetch a ChromeData stock vehicle photo", role: "authenticated" },
    ],
  },
  {
    title: "Help Center",
    endpoints: [
      { method: "GET",    path: "/api/help/articles",               description: "List help articles", role: "authenticated" },
      { method: "POST",   path: "/api/help/articles",               description: "Create a help article", role: "authenticated" },
      { method: "GET",    path: "/api/help/articles/[id]",          description: "Get a help article", role: "authenticated" },
      { method: "PUT",    path: "/api/help/articles/[id]",          description: "Update a help article", role: "authenticated" },
      { method: "DELETE", path: "/api/help/articles/[id]",          description: "Delete a help article", role: "authenticated" },
      { method: "POST",   path: "/api/help/articles/upload-image",  description: "Upload a help-article image", role: "authenticated" },
      { method: "POST",   path: "/api/help/articles/upload-video",  description: "Upload a help-article video", role: "authenticated" },
      { method: "POST",   path: "/api/help/chat",                   description: "AI help chat (streaming)", role: "authenticated" },
      { method: "GET",    path: "/api/help/conversations",          description: "List help-chat conversations", role: "authenticated" },
      { method: "GET",    path: "/api/help/conversations/[id]",     description: "Get a help conversation", role: "authenticated" },
      { method: "POST",   path: "/api/help/conversations/[id]",     description: "Append a message to a help conversation", role: "authenticated" },
      { method: "PATCH",  path: "/api/help/conversations/[id]",     description: "Update a help conversation (e.g. resolve)", role: "authenticated" },
    ],
  },
  {
    title: "QA Tooling",
    note: "super_admin QA dashboard + test-runner surface.",
    endpoints: [
      { method: "GET",    path: "/api/qa/progress",           description: "QA run progress", role: "super_admin (QA)" },
      { method: "GET",    path: "/api/qa/environment",        description: "Inspect the QA environment", role: "super_admin (QA)" },
      { method: "DELETE", path: "/api/qa/environment",        description: "Tear down the QA environment", role: "super_admin (QA)" },
      { method: "POST",   path: "/api/qa/setup-environment",  description: "Provision the QA environment", role: "super_admin (QA)" },
      { method: "GET",    path: "/api/qa/test-items",         description: "List QA test items", role: "super_admin (QA)" },
      { method: "PATCH",  path: "/api/qa/test-items/[id]",    description: "Update a QA test item", role: "super_admin (QA)" },
      { method: "GET",    path: "/api/qa/submissions",        description: "List QA submissions", role: "super_admin (QA)" },
      { method: "POST",   path: "/api/qa/submit",             description: "Submit a QA result", role: "super_admin (QA)" },
      { method: "PATCH",  path: "/api/qa/submissions/[id]",   description: "Update a QA submission", role: "super_admin (QA)" },
      { method: "GET",    path: "/api/qa/help-center",        description: "QA help-center checks", role: "super_admin (QA)" },
    ],
  },
  {
    title: "Reports",
    endpoints: [
      { method: "GET", path: "/api/reports/dealer-activity", description: "Dealer activity report", role: "authenticated" },
      { method: "GET", path: "/api/reports/options-usage",   description: "Options-usage report", role: "authenticated" },
    ],
  },
  {
    title: "Staff Profiles",
    endpoints: [
      { method: "GET",   path: "/api/staff-profile",           description: "Get the current staff member's profile", role: "authenticated" },
      { method: "PATCH", path: "/api/staff-profile",           description: "Update the current staff member's profile", role: "authenticated" },
      { method: "POST",  path: "/api/staff-profile/avatar",    description: "Upload a staff avatar", role: "authenticated" },
      { method: "GET",   path: "/api/staff-profiles",          description: "List all staff profiles", role: "super_admin" },
      { method: "PATCH", path: "/api/staff-profiles/[userId]", description: "Update a staff profile", role: "super_admin" },
    ],
  },
  {
    title: "Profiles",
    endpoints: [
      { method: "PATCH", path: "/api/profiles/active-dealer", description: "Set the active dealer for a group / super_admin session", role: "authenticated (scoped)" },
    ],
  },
  {
    title: "Webhooks & Service Integrations",
    endpoints: [
      { method: "POST", path: "/api/billing-cache/invalidate", description: "da-billing → invalidate the past-due print-lock cache", role: "webhook (secret)" },
      { method: "GET",  path: "/api/webhooks/xps",             description: "XPS shipping webhook (tracking/status verify)", role: "webhook (secret)" },
      { method: "POST", path: "/api/webhooks/xps",             description: "XPS shipping webhook (tracking/status events)", role: "webhook (secret)" },
      { method: "GET",  path: "/api/webhooks/xps/orders",      description: "XPS order webhook callback", role: "webhook" },
      { method: "POST", path: "/api/self-serve/signup",        description: "Marketing OS → create a self-serve trial dealer", role: "service key" },
      { method: "GET",  path: "/api/stats/active-dealers",     description: "Marketing OS → active-dealer count", role: "service key" },
      { method: "POST", path: "/api/stats/conversion-status",  description: "Marketing OS → conversion-status lookup", role: "service key" },
    ],
  },
  {
    title: "Health",
    endpoints: [
      { method: "GET", path: "/api/health", description: "Liveness probe (unauthenticated)", role: "public" },
    ],
  },
];

function SectionCard({ section }: { section: Section }) {
  return (
    <div>
      <p
        className="text-xs font-semibold uppercase tracking-wider mb-1"
        style={{ color: "var(--text-muted)", letterSpacing: "0.06em" }}
      >
        {section.title}
      </p>
      {section.note && (
        <p className="text-xs mb-2" style={{ color: "var(--text-muted)" }}>
          {section.note}
        </p>
      )}
      <div className="card" style={{ overflow: "hidden", marginTop: section.note ? 0 : 8 }}>
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
              style={{ background: METHOD_COLORS[ep.method].bg, color: METHOD_COLORS[ep.method].text, minWidth: 56, textAlign: "center" }}
            >
              {ep.method}
            </span>
            <code className="text-sm flex-shrink-0" style={{ color: "var(--text-primary)", fontFamily: "monospace", minWidth: 300 }}>
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
  );
}

export default async function ApiDocsPage() {
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) redirect("/login");

  const admin = createAdminSupabaseClient();
  const profile = await resolveSessionProfile<{ role: string }>(admin, session, "role");

  const role = profile?.role
    ?? (session.user.app_metadata as Record<string, unknown>)?.role as string | undefined
    ?? "dealer_user";

  if (role !== "super_admin") redirect("/dashboard");

  const totalEndpoints = NEW_PLATFORM_SECTIONS.reduce((n, s) => n + s.endpoints.length, 0);
  const legacyCount = PUBLIC_API_SECTIONS.reduce((n, s) => n + s.endpoints.length, 0);

  return (
    <div>
      <PageHeader
        title="API Documentation"
        subtitle={`${totalEndpoints + legacyCount} total endpoints — super_admin only`}
      />

      {/* Legend */}
      <div className="card p-4 mb-6 flex flex-wrap gap-4 items-center">
        <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>Method</span>
        {(["GET", "POST", "PATCH", "PUT", "DELETE"] as Method[]).map((m) => (
          <span
            key={m}
            className="text-xs font-bold px-2 py-0.5 rounded"
            style={{ background: METHOD_COLORS[m].bg, color: METHOD_COLORS[m].text }}
          >
            {m}
          </span>
        ))}
        <span className="ml-auto text-xs" style={{ color: "var(--text-muted)" }}>
          Session routes require a valid Supabase JWT cookie; public / key / webhook routes are noted per row
        </span>
      </div>

      {/* Widget & public API routes (split across DA Platform + da-api-service) */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            Widget &amp; Public API Routes
          </h2>
          <span
            className="text-xs px-2 py-0.5 rounded"
            style={{ background: "#e8f5e9", color: "#2e7d32", border: "1px solid #a5d6a7" }}
          >
            {legacyCount} endpoints
          </span>
        </div>

        <div className="flex flex-col gap-6">
          {PUBLIC_API_SECTIONS.map((section) => (
            <SectionCard key={section.title} section={section} />
          ))}
        </div>
      </div>

      {/* New Platform APIs */}
      <div>
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-primary)" }}>
            DA Platform APIs
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
            <SectionCard key={section.title} section={section} />
          ))}
        </div>
      </div>
    </div>
  );
}
