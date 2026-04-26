const MANDRILL_API = 'https://mandrillapp.com/api/1.0';

interface MandrillRecipient {
  email: string;
  name?: string;
  type?: 'to' | 'cc' | 'bcc';
}

interface MandrillMessage {
  html: string;
  subject: string;
  from_email: string;
  from_name?: string;
  to: MandrillRecipient[];
}

export async function sendMandrillEmail(message: MandrillMessage): Promise<void> {
  const apiKey = process.env.MANDRILL_API_KEY;
  if (!apiKey) {
    console.warn('[mandrill] MANDRILL_API_KEY not set — email not sent to', message.to[0]?.email);
    return;
  }
  const res = await fetch(`${MANDRILL_API}/messages/send.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: apiKey, message }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Mandrill error ${res.status}: ${text}`);
  }
}
