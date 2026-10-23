// Links from a DA-CRM contact to its platform user (contacts with user_id — migration 188).

/** The DA Users admin page, searched to this user (Users reads ?q= into its search box). */
export function platformUserHref(email: string | null | undefined): string {
  return email ? `/users?q=${encodeURIComponent(email)}` : "/users";
}
