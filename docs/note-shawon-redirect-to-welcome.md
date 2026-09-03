# For Shawon — point the 4.0 migrated-lockout redirect at /welcome (not /login)

The redirect is working — thank you. One change: it currently sends
migrated dealers to `app.dealeraddendums.com/login?new`, but there's a
page built specifically for newly-migrated dealers with the right
orientation copy and a first-time sign-in flow. Please change the redirect
target to:

```
https://app.dealeraddendums.com/welcome?from=40&email={URL-encoded user email}
```

Details:
- **URL-encode the email** in the query string (jane%40dealer.com). If it's
  malformed or missing, the page degrades gracefully to generic copy — so a
  bad encode won't break anything, but a good one lets the page pre-fill
  their email and personalize the headline ("{Dealership}'s addendum
  platform has moved").
- The `?from=40` param is what tells the page the visitor came from the 4.0
  lockout (it's also logged so we can watch lockout traffic during the
  rollout).
- Nothing else changes on your side — same trigger (dealership flagged
  migrated), just a different destination URL. `/welcome` handles the
  first-time-user experience, the email-code sign-in, and the case where
  they already have a 5.0 session (it skips them straight to the dashboard).

That's the whole change. Once it's live, "migrated dealer opens 4.0" →
lands on the branded welcome page with their email pre-filled and a one-tap
sign-in code.
