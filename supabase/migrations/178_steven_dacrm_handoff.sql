-- Steven ⇄ DA-CRM human hand-off (steven-dacrm-api.md, suite root).
-- Additive only: the existing HubSpot / email hand-off is unchanged.

-- A conversation can now be live with a DA-CRM agent.
alter table public.help_conversations drop constraint if exists help_conversations_handoff_provider_check;
alter table public.help_conversations add constraint help_conversations_handoff_provider_check
  check (handoff_provider in ('email','hubspot','dacrm'));

alter table public.help_conversations
  -- Set when the escalation was offered to DA-CRM (the webhook may still be retrying);
  -- scopes DA-CRM's poll-fallback list to conversations it was meant to see.
  add column if not exists dacrm_requested_at timestamptz,
  -- First 2xx from DA-CRM's webhook for the human_requested event.
  add column if not exists dacrm_delivered_at timestamptz,
  -- A person has picked it up (first agent reply, or DA-CRM /assign): bot → agent_active.
  add column if not exists agent_engaged_at timestamptz,
  add column if not exists assigned_agent text,
  -- The bubble's last live poll — DA-CRM's reply reports delivered=true when recent.
  add column if not exists last_seen_at timestamptz;

create index if not exists help_conversations_dacrm_idx
  on public.help_conversations (dacrm_requested_at desc, id) where dacrm_requested_at is not null;
