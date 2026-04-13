/**
 * Email sender stub — wire to Campaign Monitor in a later phase.
 * All functions are no-ops in Phase 1 beyond logging.
 */

export type EmailPayload = {
  to: string;
  subject: string;
  html: string;
  text?: string;
};

/**
 * Send a transactional email.
 * Currently a stub; will delegate to Campaign Monitor when configured.
 */
export async function sendEmail(payload: EmailPayload): Promise<void> {
  if (process.env.NODE_ENV === "development") {
    console.log("[mail] stub — would send email:", {
      to: payload.to,
      subject: payload.subject,
    });
    return;
  }

  // TODO: integrate Campaign Monitor
  // const cm = new CampaignMonitorClient(process.env.CAMPAIGN_MONITOR_API_KEY!);
  // await cm.transactional.send({ ... });

  console.warn(
    "[mail] Campaign Monitor not configured — email not sent to",
    payload.to
  );
}

/**
 * Send a password-reset notification email.
 * In practice Supabase sends the magic link directly;
 * this wrapper exists for any extra notification logic.
 */
export async function sendPasswordResetEmail(
  to: string,
  resetLink: string
): Promise<void> {
  await sendEmail({
    to,
    subject: "Reset your DA Platform password",
    html: `<p>Click <a href="${resetLink}">here</a> to reset your password. This link expires in 1 hour.</p>`,
    text: `Reset your password: ${resetLink}`,
  });
}
