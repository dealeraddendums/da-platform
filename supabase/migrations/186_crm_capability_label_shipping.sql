-- DA-CRM: "Label shipping" capability tag on the Team page (lib/crm/team.ts CAPABILITIES).
alter table crm_staff_profiles drop constraint if exists crm_staff_profiles_capabilities_check;
alter table crm_staff_profiles add constraint crm_staff_profiles_capabilities_check
  check (capabilities <@ array['tier1','tier2','feed_support','ar_ap','label_shipping']::text[]);
