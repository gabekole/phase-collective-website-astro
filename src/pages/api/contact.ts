import type { APIRoute } from 'astro';

export const prerender = false;

function jsonResponse(data: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  // Basic CSRF guard: origin must match the request host
  const origin = request.headers.get('origin');
  if (origin) {
    const requestUrl = new URL(request.url);
    if (origin !== requestUrl.origin) {
      return jsonResponse({ error: 'Forbidden' }, 403);
    }
  }

  // Parse form or JSON body
  let name = '', email = '', message = '';
  try {
    const ct = request.headers.get('content-type') ?? '';
    if (ct.includes('application/json')) {
      const data = (await request.json()) as Record<string, string>;
      name    = String(data.name    ?? '');
      email   = String(data.email   ?? '');
      message = String(data.message ?? '');
    } else {
      const data = await request.formData();
      name    = String(data.get('name')    ?? '');
      email   = String(data.get('email')   ?? '');
      message = String(data.get('message') ?? '');
    }
  } catch {
    return jsonResponse({ error: 'Invalid request body' }, 400);
  }

  // Sanitize lengths
  name    = name.trim().slice(0, 128);
  email   = email.trim().slice(0, 254);
  message = message.trim().slice(0, 4000);

  // Validate required fields
  if (!name || !email || !message) {
    return jsonResponse({ error: 'Name, email, and message are required.' }, 422);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ error: 'Invalid email address.' }, 422);
  }
  // Recipient — override via CONTACT_EMAIL env var (set in Cloudflare dashboard or wrangler.json vars)
  const env = (request as unknown as { cf?: { env?: { CONTACT_EMAIL?: string } } }).cf?.env;
  const recipientEmail =
    (env?.CONTACT_EMAIL) ?? 'contact@phasecollectives.com';

  // Send via MailChannels (free on Cloudflare Workers)
  // Requires a _mailchannels TXT record on your domain for domain-lock.
  // See: https://support.mailchannels.com/hc/en-us/articles/16918954360845
  try {
    const mcResponse = await fetch('https://api.mailchannels.net/tx/v1/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: recipientEmail, name: 'Phase Collective' }] }],
        from: {
          email: 'noreply@phasecollectives.com',
          name: 'Phase Collective Website',
        },
        reply_to: { email, name },
        subject: `Contact form submission \u2014 ${name}`,
        content: [
          {
            type: 'text/plain',
            value: [
              `Name:    ${name}`,
              `Email:   ${email}`,
              '',
              message,
            ].join('\n'),
          },
        ],
      }),
    });

    if (mcResponse.status === 202) {
      return jsonResponse({ ok: true }, 200);
    }

    const body = await mcResponse.text();
    console.error('[contact] MailChannels error', mcResponse.status, body);
    return jsonResponse({ error: 'Failed to send message. Please try again.' }, 500);
  } catch (err) {
    console.error('[contact] fetch error', err);
    return jsonResponse({ error: 'Server error. Please try again.' }, 500);
  }
};
