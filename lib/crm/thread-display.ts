// How Inbox threads are shown (never stored): the mailbox as "Support" / "Feeds", not its address, and
// subjects without vendor / thread tokens. The raw subject stays in crm_email_threads / crm_emails and is
// what matching uses.

export type MailboxLike = { purpose?: string | null; display_name?: string | null; address?: string | null };

/** "Support" / "Feeds" — from purpose, else display_name without the brand; never the address. */
export function mailboxLabel(m: MailboxLike | null | undefined): string | null {
  if (!m) return null;
  const p = (m.purpose ?? "").trim();
  if (p) return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase();
  const d = (m.display_name ?? "").replace(/^\s*dealer\s*addendums\s*/i, "").trim();
  if (d && !d.includes("@")) return d;
  return "Mailbox";
}

// Bracketed tokens vendors' ticket systems add: "[ thread::abc:: ]", "[ ref:!00D…:ref ]", "[#12345]",
// "[Case #000123]", "[Ticket#4411]", "[ThreadID:…]". Plain tags like "[EXTERNAL]" stay.
const TOKEN = /\[\s*(?:[^\]]*::[^\]]*|ref:[^\]]*|#\s*\d[\w-]*|(?:case|ticket|request|incident)\s*#?\s*:?\s*\d[\w-]*|thread\s*id\s*:[^\]]*)\s*\]/gi;
const PREFIX = /^(?:\s*(?:re|aw|sv)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** Subject for display: tokens stripped, "Re: RE: re:" → one "Re:", whitespace collapsed. */
export function displaySubject(raw: string | null | undefined): string {
  let s = (raw ?? "").replace(TOKEN, " ");
  s = s.replace(/\s+/g, " ").trim();
  const reply = PREFIX.test(s);
  s = s.replace(PREFIX, "").trim();
  // Re: inside a forward ("Fwd: Re: Re: x") collapses too.
  s = s.replace(/((?:re|aw|sv)\s*:\s*)(?:(?:re|aw|sv)\s*:\s*)+/gi, "Re: ");
  s = s.replace(/\s*[-–|:]\s*$/, "").trim();
  return reply ? (s ? `Re: ${s}` : "Re:") : s;
}
