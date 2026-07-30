-- Migration 136: per-feed push schedule for Feed Exports.
--
-- Feed pushes were manual-only (the Push button on /admin/feeds). Each feed
-- can now be scheduled: 'manual' (never auto-pushed, default — matches
-- existing behavior), 'hourly', or 'daily'. Executed by the new
-- POST /api/cron/push-feeds?schedule={hourly|daily} route (X-Cron-Secret),
-- registered as two EasyCron jobs.

alter table feed_companies
  add column if not exists push_schedule text not null default 'manual'
  check (push_schedule in ('manual', 'hourly', 'daily'));

comment on column feed_companies.push_schedule is
  'Automatic push cadence: manual (Push button only), hourly, or daily. Consumed by /api/cron/push-feeds.';
