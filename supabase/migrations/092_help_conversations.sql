-- Help/Support widget — conversation logging (Phase A).
-- Own-data-only: a conversation belongs to one user + their effective dealer, and
-- stores the dealer's help Q&A + the same own-account context snapshot the
-- assistant already had. NEVER card/PII/cross-dealer.

CREATE TABLE IF NOT EXISTS public.help_conversations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  dealer_id    text,                                  -- effective dealer (own/active); may be null
  role         text,
  group_id     text,
  context_snapshot text NOT NULL DEFAULT '',          -- the dealer-safe context block used
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open','escalated','resolved')),
  flagged      boolean NOT NULL DEFAULT false,        -- set when any answer gets a 👎
  escalated_at timestamptz,
  escalation_notified_at timestamptz,                 -- debounce: one Mandrill notify per escalation
  resolved_at  timestamptz,
  resolved_by  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  hubspot_logged_at timestamptz,                      -- last time the transcript was synced to HubSpot
  hubspot_note_id text,                               -- the HubSpot Note id (upsert: create once, update on later closes/resolve)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.help_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.help_conversations(id) ON DELETE CASCADE,
  role            text NOT NULL CHECK (role IN ('user','assistant','agent')),
  content         text NOT NULL DEFAULT '',
  feedback        text CHECK (feedback IN ('up','down')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS help_conversations_status_idx ON public.help_conversations (status, flagged, created_at DESC);
CREATE INDEX IF NOT EXISTS help_conversations_user_idx ON public.help_conversations (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS help_messages_conv_idx ON public.help_messages (conversation_id, created_at);

-- ── RLS (defense-in-depth; app uses the service-role client with auth enforced
--    in the API). A user may read their own conversations/messages; super_admin
--    (the support team, migration 088) may read/manage all. ──────────────────
ALTER TABLE public.help_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS help_conv_owner_read ON public.help_conversations;
CREATE POLICY help_conv_owner_read ON public.help_conversations
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS help_conv_super_all ON public.help_conversations;
CREATE POLICY help_conv_super_all ON public.help_conversations
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));

DROP POLICY IF EXISTS help_msg_owner_read ON public.help_messages;
CREATE POLICY help_msg_owner_read ON public.help_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM public.help_conversations c WHERE c.id = help_messages.conversation_id AND c.user_id = auth.uid())
  );

DROP POLICY IF EXISTS help_msg_super_all ON public.help_messages;
CREATE POLICY help_msg_super_all ON public.help_messages
  FOR ALL
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'))
  WITH CHECK (EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'super_admin'));
