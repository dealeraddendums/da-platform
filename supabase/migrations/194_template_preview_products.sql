-- 194_template_preview_products.sql — Template Builder preview selection (builder-only).
--
-- Which products the Builder canvas previews for a template: { mode: all | picked | vehicle,
-- picked: { New: [key], Used: [key], CPO: [key] }, vehicle: { id, stock } }. Keys are "lib:<addendum_library.id>"
-- / "grp:<group_options.id>". Shared by everyone editing the template; survives reload.
--
-- PREVIEW ONLY. Nothing in the print pipeline reads this column (it reads template_json only —
-- lib/template-resolver.ts, app/api/pdf/**); scripts/builder-preview-verify-unit.ts asserts that.
-- Written by PUT /api/builder/preview-selection, never by the template save.
alter table public.templates add column if not exists preview_products jsonb;
alter table public.group_templates add column if not exists preview_products jsonb;
comment on column public.templates.preview_products is 'Template Builder canvas preview selection only — never read by printing.';
comment on column public.group_templates.preview_products is 'Template Builder canvas preview selection only — never read by printing.';
