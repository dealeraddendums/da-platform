// Modules that subscribe to onInboundEmail (lib/crm/email-hooks.ts). The Inbox
// sync imports this file once, so a module's registerInboundEmailHandler()
// call runs before the first email is dispatched. Add one import per module.
//
import "./feeds/inbound";     // Phase 2b — feeds@ approvals + Feed IDs
