import type { APIRoute } from 'astro';

export const prerender = false;

function jsonResponse(data: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request, locals }) => {
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
  const runtime = (locals as { runtime?: { env?: { CONTACT_EMAIL?: string; RESEND_API_KEY?: string } } }).runtime;
  const recipientEmail = runtime?.env?.CONTACT_EMAIL ?? 'contact@phasecollectives.com';
  const resendApiKey = runtime?.env?.RESEND_API_KEY;

  if (!resendApiKey) {
    console.error('[contact] RESEND_API_KEY is not set');
    return jsonResponse({ error: 'Server configuration error.' }, 500);
  }

  // Send via Resend (https://resend.com — free tier: 3,000 emails/month)
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${resendApiKey}`,
      },
      body: JSON.stringify({
        from: 'Phase Collective <contact@phasecollectives.com>',
        to: [recipientEmail],
        reply_to: email,
        subject: `Contact form submission \u2014 ${name}`,
        text: [`Name:    ${name}`, `Email:   ${email}`, '', message].join('\n'),
      }),
    });

    if (res.ok) {
      return jsonResponse({ ok: true }, 200);
    }

    const body = await res.text();
    console.error('[contact] Resend error', res.status, body);
    return jsonResponse({ error: 'Failed to send message. Please try again.' }, 500);
  } catch (err) {
    console.error('[contact] fetch error', err);
    return jsonResponse({ error: 'Server error. Please try again.' }, 500);
  }
};
