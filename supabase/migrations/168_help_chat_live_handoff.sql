-- 168_help_chat_live_handoff.sql — Steven (in-app chat): live HubSpot hand-off,
-- files, selective tickets. Additive only.
--
-- The HubSpot side is the custom-channel bridge in da-marketing-os (one bridge,
-- two surfaces): da-platform asks it to publish a Steven thread into the
-- Support inbox, and it forwards agent replies back here (/api/help/hubspot-relay).

alter table help_conversations
  -- logConversationToHubspot() has always read/written this, but the column was
  -- never created in prod — the select failed and the close-time transcript
  -- note silently never happened.
  add column if not exists hubspot_note_id text,
  -- Where an escalation went: 'email' (support@ Mandrill) or 'hubspot' (live,
  -- in the Support inbox). NULL = never escalated / escalated before this.
  add column if not exists handoff_provider text
    check (handoff_provider in ('email','hubspot')),
  -- When the conversation went live with a person; the bubble's poll cursor.
  add column if not exists live_at timestamptz,
  -- HubSpot's own thread id + the contact it resolved (from the relay).
  add column if not exists hubspot_thread_id text,
  add column if not exists hubspot_contact_id text,
  -- Set ONLY when a person chooses "Make this a ticket" — never automatic.
  -- One ticket per conversation; a repeat trigger returns this one.
  add column if not exists hubspot_ticket_id text,
  add column if not exists ticketed_at timestamptz,
  -- The page the dealer was on when they asked (for the agent's context).
  add column if not exists page text;

alter table help_messages
  -- [{ name, mime, size, path }] — path is in the private help-chat bucket.
  add column if not exists attachments jsonb not null default '[]'::jsonb,
  -- The agent's display name ("Allan") on role='agent' rows.
  add column if not exists sender_name text,
  -- HubSpot message id — dedupes a retried relay.
  add column if not exists external_id text;

create unique index if not exists help_messages_external_id_idx
  on help_messages (external_id) where external_id is not null;

create index if not exists help_conversations_ticket_idx
  on help_conversations (dealer_id) where hubspot_ticket_id is not null;
