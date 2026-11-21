import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { config } from '../config.js';
import { notifyOwner } from '../notify.js';
import { validTwilioSignature } from './twilio.js';

/**
 * Voz del número del negocio (Twilio → "A call comes in" → POST /twilio/voice).
 *  - Cualquier persona: se desvía al celular del dueño; si no contesta, buzón y aviso por correo.
 *  - El dueño (desde OWNER_MOBILE) + PIN: marca un número de EE. UU./Canadá y sale con el número del negocio.
 */

const esc = (s: string) => s.replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]!));
const res = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
const sayEs = (t: string) => `<Say voice="Polly.Lupe" language="es-US">${esc(t)}</Say>`;
const sayEn = (t: string) => `<Say voice="Polly.Joanna" language="en-US">${esc(t)}</Say>`;
const abs = (path: string) => `${config.publicUrl}/twilio/voice${path}`;

// Códigos de área del plan norteamericano que son de otros países (cobran como internacional).
const FOREIGN_NANP = new Set(['242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767', '784', '809', '829', '849', '868', '869', '876']);
const PREMIUM = new Set(['900', '976']);

/** Normaliza lo marcado a E.164 de EE. UU./Canadá, o null si no se permite. */
export function normalizeDialed(digits: string): string | null {
  let d = (digits || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return null;
  const area = d.slice(0, 3), exchange = d.slice(3, 6);
  if (!/^[2-9]/.test(area) || !/^[2-9]/.test(exchange)) return null;
  if (/^[2-9]11$/.test(area) || PREMIUM.has(area) || FOREIGN_NANP.has(area)) return null;
  return `+1${d}`;
}

const sameNumber = (a?: string, b?: string) => !!a && !!b && a.replace(/\D/g, '').slice(-10) === b.replace(/\D/g, '').slice(-10);

function pinOk(given: string | undefined, pin: string) {
  const a = Buffer.from(given || ''), b = Buffer.from(pin);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Valida la firma de Twilio y devuelve los parámetros, o una respuesta de error. */
async function verified(c: Context): Promise<Record<string, string> | Response> {
  const token = config.twilio.authToken();
  if (!token) return c.notFound();
  const form = await c.req.parseBody();
  const params = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, String(v)]));
  if (!validTwilioSignature(token, `${config.publicUrl}${c.req.path}`, params, c.req.header('x-twilio-signature'))) {
    return c.text('Bad signature', 403);
  }
  return params;
}

export function voiceRoutes() {
  const app = new Hono();
  const xmlOut = (c: Context, body: string) => c.body(res(body), 200, { 'Content-Type': 'text/xml' });
  const voicemail = () =>
    sayEs('Gracias por llamar a all4kloud. Deje su nombre, su número y en qué le podemos ayudar, y le devolvemos la llamada.') +
    sayEn('Thanks for calling all4kloud. Please leave your name, number and how we can help, and we will call you back.') +
    `<Record maxLength="120" playBeep="true" action="${abs('/recorded')}" />`;

  // Entrada de toda llamada al número del negocio
  app.post('/', async c => {
    const p = await verified(c); if (p instanceof Response) return p;
    const owner = config.voice.ownerMobile(), pin = config.voice.pin();
    if (owner && pin && sameNumber(p.From, owner)) {
      return xmlOut(c, `<Gather input="dtmf" finishOnKey="#" timeout="8" action="${abs('/pin')}">${sayEs('Marque su PIN y la tecla numeral.')}</Gather>${sayEs('Adiós.')}`);
    }
    if (!owner) return xmlOut(c, voicemail());
    return xmlOut(c, `<Dial timeout="${config.voice.ringSeconds}" action="${abs('/after-dial')}">${esc(owner)}</Dial>`);
  });

  // Después de intentar el celular del dueño
  app.post('/after-dial', async c => {
    const p = await verified(c); if (p instanceof Response) return p;
    if (p.DialCallStatus === 'completed' || p.DialCallStatus === 'answered') return xmlOut(c, '<Hangup/>');
    return xmlOut(c, voicemail());
  });

  // Mensaje de voz grabado → aviso por correo con enlace al registro de la llamada en la consola
  app.post('/recorded', async c => {
    const p = await verified(c); if (p instanceof Response) return p;
    const secs = Number(p.RecordingDuration || 0);
    if (secs > 0) {
      const link = p.CallSid ? `https://console.twilio.com/us1/monitor/logs/calls/${encodeURIComponent(p.CallSid)}` : '(sin enlace)';
      await notifyOwner(
        `Mensaje de voz de ${p.From || 'número oculto'} (${secs} s)`,
        `Nuevo mensaje de voz en el número de all4kloud.\n\nDe: ${p.From || 'número oculto'}\nDuración: ${secs} segundos\n\nEscúchalo en la consola de Twilio (registro de la llamada → Recordings):\n${link}`,
      );
    }
    return xmlOut(c, `${sayEs('Gracias. Adiós.')}<Hangup/>`);
  });

  // PIN del dueño
  app.post('/pin', async c => {
    const p = await verified(c); if (p instanceof Response) return p;
    const owner = config.voice.ownerMobile(), pin = config.voice.pin();
    if (!owner || !pin || !sameNumber(p.From, owner) || !pinOk(p.Digits, pin)) {
      return xmlOut(c, `${sayEs('PIN incorrecto. Adiós.')}<Hangup/>`);
    }
    return xmlOut(c, `<Gather input="dtmf" finishOnKey="#" timeout="10" action="${abs('/dial')}">${sayEs('Marque el número de diez dígitos y la tecla numeral.')}</Gather>${sayEs('Adiós.')}`);
  });

  // Llamada saliente con el número del negocio como identificador
  app.post('/dial', async c => {
    const p = await verified(c); if (p instanceof Response) return p;
    const owner = config.voice.ownerMobile();
    if (!owner || !config.voice.pin() || !sameNumber(p.From, owner)) return xmlOut(c, '<Hangup/>');
    const target = normalizeDialed(p.Digits || '');
    const callerId = /^\+1\d{10}$/.test(p.To || '') ? p.To : '';
    if (!target || !callerId) {
      return xmlOut(c, `${sayEs('Ese número no se puede marcar. Solo números de Estados Unidos y Canadá. Adiós.')}<Hangup/>`);
    }
    return xmlOut(c, `<Dial callerId="${esc(callerId)}" timeout="30">${esc(target)}</Dial>`);
  });

  return app;
}
