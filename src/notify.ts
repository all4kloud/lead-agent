import { config } from './config.js';

/** Aviso a German por email (Resend). Nunca rompe la conversación si falla. */
export async function notifyOwner(subject: string, text: string, fetchImpl: typeof fetch = fetch) {
  const key = config.resendKey();
  if (!key) { console.log('[notify] (Resend no configurado)', subject); return; }
  try {
    const r = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `Agente all4kloud <${config.resendFrom}>`, to: [config.notifyEmail], subject, text }),
    });
    if (!r.ok) console.error('[notify]', r.status, await r.text());
  } catch (e) {
    console.error('[notify]', e);
  }
}
