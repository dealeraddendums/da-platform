# DA-CRM Inbox — Microsoft 365 runbook

The DA-CRM Inbox (`/crm/communications/inbox`) syncs the shared mailboxes **support@dealeraddendums.com** and
**feeds@dealeraddendums.com** through Microsoft Graph. Staff reply from DA-CRM and the mail goes out from the
mailbox itself, threaded in Outlook, so Outlook stays the system of record. Mandrill is for transactional
system email only. The CRM never sends through Mandrill.

**Graph addresses mailboxes by object id, not by email address.** Each `crm_mailboxes` row has a
`graph_user_id` (the mailbox's Entra object id), and every Graph call is `/users/{graph_user_id}/…`.
`address` is used only for display and as the sending address (`from` on every draft):

| address (display / sending) | graph_user_id | Notes |
|---|---|---|
| support@dealeraddendums.com | `c5c91bb5-14ea-4408-bd6c-4760064f2817` | an alias on the mailbox whose primary username is "home" |
| feeds@dealeraddendums.com | `8d4fe1f7-b311-402b-8bb9-75004244e11f` | shared mailbox |

Migration 181 seeds both ids. A row without a `graph_user_id` is skipped, and `--check` reports it.
Sending from the support@ alias rather than the primary address needs Exchange's
`Set-OrganizationConfig -SendFromAliasEnabled $true`. support@'s Sent Items already show support@, so this
looks to be in place. If a send ever fails with a send-as error, check this setting first.

## 1. Azure app registration (Allan, one time)

The app already exists (its ids are `MS_TENANT_ID` / `MS_CLIENT_ID` / `MS_CLIENT_SECRET` in
`/var/www/da-platform/.env.local`). Check or set:

1. **portal.azure.com → Microsoft Entra ID → App registrations → (the DA-CRM app)**.
2. **API permissions → Add a permission → Microsoft Graph → Application permissions**:
   - `Mail.Read`
   - `Mail.ReadWrite`
   - `Mail.Send`

   Remove any *Delegated* mail permissions this feature doesn't need.
3. Click **Grant admin consent for DealerAddendums**. Each of the three should show a green "Granted" tick.
4. **Certificates & secrets**: note the client secret's expiry date. When you rotate it:
   - put the new value in `.env.local` (`MS_CLIENT_SECRET=`)
   - run `pm2 reload da-platform`, because the app reads `.env.local` once per process.

## 2. Limit the app to support@ and feeds@ (Exchange Online)

Without this, the application permissions above can read **every** mailbox in the tenant. Run these in
Exchange Online PowerShell as a global or Exchange admin:

```powershell
Connect-ExchangeOnline -UserPrincipalName allan@dealeraddendums.com

# A mail-enabled security group holding exactly the mailboxes DA-CRM may touch
New-DistributionGroup -Name "DA-CRM Graph Mailboxes" -Alias da-crm-graph -Type Security `
  -Members support@dealeraddendums.com, feeds@dealeraddendums.com

# Restrict the app (AppId = MS_CLIENT_ID) to that group
New-ApplicationAccessPolicy -AppId <MS_CLIENT_ID> -PolicyScopeGroupId da-crm-graph@dealeraddendums.com `
  -AccessRight RestrictAccess -Description "DA-CRM: support@ and feeds@ only"

# Verify. The first two should say Granted, the last one Denied.
Test-ApplicationAccessPolicy -Identity support@dealeraddendums.com -AppId <MS_CLIENT_ID>
Test-ApplicationAccessPolicy -Identity feeds@dealeraddendums.com   -AppId <MS_CLIENT_ID>
Test-ApplicationAccessPolicy -Identity allan@dealeraddendums.com   -AppId <MS_CLIENT_ID>
```

- **Propagation:** policy changes can take up to an hour to reach Graph.
- **Mailbox type:** both mailboxes can be *shared mailboxes*, which need no license.
- **Newer alternative:** Microsoft's "RBAC for Applications" (`New-ManagementScope` +
  `New-ManagementRoleAssignment -App …`) does the same job. Use one approach or the other, not both.

## 3. Verify from the server (Claude Code does this)

```bash
cd /var/www/da-platform/current
npm run crm:graph-setup -- --check --outside allan@dealeraddendums.com
```

The check passes when:
- the token is OK
- support@ and feeds@ are both "readable"
- allan@ is "blocked (good)"

If allan@ comes back readable, the access policy isn't in force yet.

## 4. Go live (Claude Code does this)

1. **Webhook secret.** `MS_GRAPH_WEBHOOK_SECRET` (random, 64 hex) goes in `.env.local`, then run
   `pm2 reload da-platform`. Graph echoes this value back as `clientState` on every notification, and the
   webhook drops anything that doesn't match.
2. **Subscriptions.** Run `npm run crm:graph-setup -- --subscribe --apply`. This creates the Inbox and Sent Items
   change-notification subscriptions for each mailbox. Graph validates
   `https://app.dealeraddendums.com/api/crm/graph/webhook` while it does this. Nothing needs registering in the
   Azure portal: the subscription itself carries the URL.
3. **Backfill.** `npm run crm:graph-backfill` is a dry run that prints the counts. Then
   `npm run crm:graph-backfill -- --apply` loads the last 90 days of Inbox and Sent Items per mailbox and saves
   the delta links the 10-minute sync continues from. It's idempotent, so it's safe to re-run.
4. **EasyCron** (header `X-Cron-Secret: $CRON_SECRET`):

| Schedule | URL | Why |
|---|---|---|
| `*/10 * * * *` | `POST /api/cron/crm-graph-sync` | delta fallback for anything a notification missed |
| `0 */12 * * *` | `POST /api/cron/crm-graph-subscriptions` | renew subscriptions (they last about 70 h; renewal happens inside 30 h of expiry) and recreate dropped ones |

The spec says "every 48 h" for the renewal job, and that works too. Every 12 h simply gives three retries
before an expiry.

## Everyday operations

- **Add a mailbox:**
  1. Run `insert into crm_mailboxes (address, graph_user_id, display_name, purpose) values ('x@dealeraddendums.com', '<Entra object id>', 'Name', 'support');`
     (`purpose` is `support` or `feeds`; widen the check constraint for a new kind). The object id is on the
     user or shared mailbox in Entra, or from `(Get-Mailbox x@…).ExternalDirectoryObjectId`.
  2. Add the address to the `da-crm-graph` group.
  3. Wait for the policy to propagate.
  4. Run `crm:graph-setup -- --subscribe --apply`.
  5. Run `crm:graph-backfill -- --mailbox x@dealeraddendums.com --apply`.
- **Re-run the backfill:**
  - add `--days 30` for a narrower window
  - add `--restart` to ignore the saved delta link
  - add `--mailbox …` to limit it to one mailbox

  Rows already stored are skipped.
- **Ignore list** (automated senders that are never stored):
  - It lives in `crm_settings.email_ignore_senders`, a JSON array of case-insensitive substrings of the From
    address (`'@domain'` entries match a domain).
  - To change it, run `update crm_settings set email_ignore_senders = '[...]'::jsonb;`
  - Calendar invites are always skipped.
  - `Auto-Submitted` mail is **kept**, because feed suppliers send Feed IDs that way.
- **Internal domains:** `crm_settings.email_internal_domains` (default `["dealeraddendums.com"]`). A thread with
  only those addresses on it is marked internal and never shows as Unassigned.
- **Health:** `crm_mailboxes.last_synced_at` / `last_error`. The Inbox shows a banner when a mailbox has an error.
