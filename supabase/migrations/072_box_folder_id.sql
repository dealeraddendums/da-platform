-- Migration 072: Box folder linkage for dealers and groups.
--
-- Each dealer and group gets a Box.com folder created on first save
-- (POST /api/dealers, POST /api/groups). The fire-and-forget helper in
-- lib/box.ts stores the returned folder id here so other surfaces (the
-- dealer/group detail page, future doc-upload flows) can deep-link into
-- Box without re-resolving the name. Failures land in
-- billing_sync_errors with event_type='box.folder.create'.

ALTER TABLE public.dealers
  ADD COLUMN IF NOT EXISTS box_folder_id text;

ALTER TABLE public.groups
  ADD COLUMN IF NOT EXISTS box_folder_id text;

CREATE INDEX IF NOT EXISTS dealers_box_folder_id_idx ON public.dealers (box_folder_id) WHERE box_folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS groups_box_folder_id_idx  ON public.groups  (box_folder_id) WHERE box_folder_id IS NOT NULL;
