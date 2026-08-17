/**
 * Sends application emails via the user's connected Gmail (Replit connector).
 *
 * The client is fetched fresh on every send — connector tokens expire and must
 * never be cached. If Gmail is not connected, this throws a clear
 * "Gmail is not connected" error that the apply engine turns into a
 * needs_user state (never a silent failure).
 */
import { google } from 'googleapis';

async function getAccessToken(): Promise<string> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  const xReplitToken = process.env.REPL_IDENTITY
    ? 'repl ' + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? 'depl ' + process.env.WEB_REPL_RENEWAL
      : null;
  if (!hostname || !xReplitToken) {
    throw new Error('Gmail is not connected (no connector environment available)');
  }
  const res = await fetch(
    `https://${hostname}/api/v2/connection?include_secrets=true&connector_names=google-mail`,
    { headers: { Accept: 'application/json', X_REPLIT_TOKEN: xReplitToken } },
  );
  if (!res.ok) throw new Error(`Gmail is not connected (connection settings fetch failed: ${res.status})`);
  const data = await res.json();
  const connectionSettings = data.items?.[0];
  const accessToken = connectionSettings?.settings?.access_token
    ?? connectionSettings?.settings?.oauth?.credentials?.access_token;
  if (!connectionSettings || !accessToken) {
    throw new Error('Gmail is not connected. Connect the Gmail integration to send application emails.');
  }
  return accessToken;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Header-injection guard: any CR/LF in a value that lands in a MIME header
 * (To, Subject, filename) is rejected outright — user/AI-supplied subjects
 * must never be able to smuggle extra headers (e.g. Bcc) into the message.
 */
export function assertNoHeaderInjection(label: string, value: string): void {
  if (/[\r\n\0]/.test(value)) throw new Error(`${label} contains forbidden line-break characters`);
}

/** Builds an RFC 2822 MIME message (plain text + optional PDF attachment). */
export function buildMimeMessage(opts: {
  to: string; subject: string; body: string;
  attachment?: { filename: string; content: Buffer };
}): string {
  assertNoHeaderInjection('Recipient', opts.to);
  assertNoHeaderInjection('Subject', opts.subject);
  if (opts.attachment) {
    assertNoHeaderInjection('Attachment filename', opts.attachment.filename);
    if (opts.attachment.filename.includes('"')) throw new Error('Attachment filename contains forbidden characters');
  }
  // RFC 2047 encode the subject to survive non-ASCII characters
  const subject = /^[\x20-\x7e]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${Buffer.from(opts.subject).toString('base64')}?=`;
  if (!opts.attachment) {
    return [
      `To: ${opts.to}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: 7bit',
      '',
      opts.body,
    ].join('\r\n');
  }
  const boundary = `----=_Part_${Date.now().toString(36)}`;
  return [
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    opts.body,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${opts.attachment.filename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
    '',
    opts.attachment.content.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    `--${boundary}--`,
  ].join('\r\n');
}

/** Sends the email through Gmail; returns the Gmail message id. */
export async function sendApplicationEmail(opts: {
  to: string; subject: string; body: string;
  attachment?: { filename: string; content: Buffer };
}): Promise<string> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(opts.to)) throw new Error(`Invalid recipient email: ${opts.to}`);
  const accessToken = await getAccessToken();
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  const gmail = google.gmail({ version: 'v1', auth });
  const raw = base64Url(buildMimeMessage(opts));
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  if (!res.data.id) throw new Error('Gmail send returned no message id');
  console.log(`[EMAIL] Sent application email to ${opts.to} (message ${res.data.id})`);
  return res.data.id;
}
