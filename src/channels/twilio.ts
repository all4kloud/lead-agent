import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { config } from '../config.js';
import { guessLang, isStart, isStop } from '../guardrails.js';
import { handleMessage, startConversation, type EngineDeps } from '../engine.js';
import type { Channel } from '../store.js';

/**
 * Firma de Twilio: HMAC-SHA1 (con el Auth Token) de la URL completa + parámetros POST
 * ordenados por nombre (nombre+valor concatenados), en base64.
 * https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function validTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined) {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

const xml = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const twiml = (msg?: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Response>${msg ? `<Message>${xml(msg)}</Message>` : ''}</Response>`;

/** Webhooks de mensajes entrantes. Apagados (404) mientras no exista TWILIO_AUTH_TOKEN. */
export function twilioRoutes(deps: EngineDeps) {
  const app = new Hono();
  const handler = (channel: Channel) => async (c: import('hono').Context) => {
    const token = config.twilio.authToken();
    if (!token) return c.notFound();
    const form = await c.req.parseBody();
    const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
    const url = `${config.publicUrl}${c.req.path}`;
    if (!validTwilioSignature(token, url, params, c.req.header('x-twilio-signature'))) return c.text('Bad signature', 403);

    const from = params.From || '';
    const body = (params.Body || '').trim();
    if (!from) return c.text('Missing From', 400);

    let conv = await deps.store.findByExternal(channel, from);
    // baja / alta (en SMS Twilio además bloquea los envíos solo)
    if (isStop(body)) {
      if (conv) {
        await deps.store.updateConversation(conv.id, { opted_out: true });
        await deps.store.recordConsent({ conversation_id: conv.id, channel, contact: from, granted: false, text: `Baja: "${body}"` });
      }
      return c.body(twiml(), 200, { 'Content-Type': 'text/xml' });
    }
    if (conv?.opted_out && !isStart(body)) return c.body(twiml(), 200, { 'Content-Type': 'text/xml' });
    if (conv?.opted_out && isStart(body)) await deps.store.updateConversation(conv.id, { opted_out: false });

    let prefix = '';
    if (!conv) {
      const lang = guessLang(body);
      conv = (await startConversation(deps.store, channel, from, lang)).conv;
      prefix = lang === 'en' ? 'all4kloud virtual assistant (AI). Reply STOP to opt out. ' : 'Asistente virtual de all4kloud (IA). Responde STOP o BAJA para no recibir mensajes. ';
    }
    const reply = await handleMessage(conv, body || '(mensaje vacío)', deps);
    return c.body(twiml(prefix + reply.text), 200, { 'Content-Type': 'text/xml' });
  };
  app.post('/sms', handler('sms'));
  app.post('/whatsapp', handler('whatsapp'));
  return app;
}
