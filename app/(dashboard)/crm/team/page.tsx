// DA-CRM Team. Everyone sees the team and edits their own card (hours,
// signature, photo); crm_admin adds members, sets team / capabilities /
// Dialpad mapping / admin access, and manages DA-CRM settings + webhooks.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { PageHeader } from "@/components/PageHeader";
import TeamClient, { type Member } from "@/components/crm/TeamClient";
import { requireCrmPage } from "@/lib/crm/page-guard";
import { crmAdmin } from "@/lib/crm/queries";

export const metadata = { title: "Team — DA-CRM" };

export default async function CrmTeamPage() {
  const { userId, perms } = await requireCrmPage("/crm/team");
  const admin = crmAdmin();
  const [{ data: profiles }, { data: grants }, { data: settings }, { data: admins }] = await Promise.all([
    admin.from("crm_staff_profiles").select("*").order("full_name"),
    admin.from("staff_permissions").select("user_id, permission").in("permission", ["crm", "crm_admin"]),
    admin.from("crm_settings").select("platform_name, logo_s3_key").eq("id", true).maybeSingle(),
    perms.crmAdmin ? admin.from("profiles").select("id, email, full_name").eq("role", "super_admin").eq("active", true).order("email") : Promise.resolve({ data: [] }),
  ]);
  const granted = new Map<string, Set<string>>();
  for (const g of grants ?? []) granted.set(g.user_id, (granted.get(g.user_id) ?? new Set()).add(g.permission));
  const ids = (profiles ?? []).map((p: any) => p.staff_id);
  const { data: logins } = ids.length ? await admin.from("profiles").select("id, email").in("id", ids) : { data: [] };
  const emailOf = Object.fromEntries((logins ?? []).map((l: any) => [l.id, l.email]));

  const members: Member[] = (profiles ?? []).map((p: any) => ({
    staff_id: p.staff_id,
    email: emailOf[p.staff_id] ?? "",
    full_name: p.full_name,
    team: p.team,
    capabilities: p.capabilities ?? [],
    work_hours: p.work_hours ?? {},
    time_zone: p.time_zone,
    cell_phone: p.cell_phone,
    email_signature_html: p.email_signature_html,
    has_photo: !!p.photo_s3_key,
    photo_v: p.photo_s3_key ? p.photo_s3_key.slice(-12) : "",
    dialpad_user_id: p.dialpad_user_id,
    dialpad_number: p.dialpad_number,
    active: p.active,
    is_admin: granted.get(p.staff_id)?.has("crm_admin") ?? false,
  }));
  const candidates = (admins ?? []).filter((a: any) => !ids.includes(a.id));

  return (
    <div>
      <PageHeader title="Team" subtitle="Customer Support and Management — hours, capabilities, Dialpad mapping and email signatures." />
      <TeamClient
        members={members}
        currentUserId={userId}
        isAdmin={perms.crmAdmin}
        candidates={candidates.map((c: any) => ({ id: c.id, label: c.full_name ? `${c.full_name} (${c.email})` : c.email }))}
        settings={{ platform_name: settings?.platform_name ?? "DA-CRM", has_logo: !!settings?.logo_s3_key, logo_v: settings?.logo_s3_key?.slice(-12) ?? "" }}
      />
    </div>
  );
}
