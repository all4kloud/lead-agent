/**
 * Guardrails deterministas: viven en el código, no solo en el prompt.
 * El modelo puede equivocarse; estas reglas no.
 */
export type Lang = 'es' | 'en';
export type Violation = 'price' | 'promise' | 'sensitive_request' | 'too_long';

/** Precios que el agente sí puede mencionar (públicos). */
export const ALLOWED_PRICES = ['$100'];

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
};

/**
 * Quita del mensaje del usuario datos que nunca deben guardarse ni enviarse al modelo:
 * números de tarjeta (validados con Luhn) y números de seguro social.
 */
export function redactInbound(text: string): { text: string; redacted: string[] } {
  const redacted: string[] = [];
  let out = text.replace(/\b(?:\d[ -]?){13,19}\b/g, m => {
    const digits = m.replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) { redacted.push('card'); return '[dato eliminado]'; }
    return m;
  });
  out = out.replace(/\b\d{3}-\d{2}-\d{4}\b/g, () => { redacted.push('ssn'); return '[dato eliminado]'; });
  return { text: out, redacted };
}

const PRICE_RE = /(?:US\$|\$)\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|d[oó]lares|dollars|bucks)\b/gi;
const PROMISE_RE = /\b(garantiz\w*|guarantee\w*|te aseguro que|le aseguro que|i promise|we promise|prometemos|sin ning[uú]n riesgo|risk[- ]free|100\s?% (?:seguro|garantizado|guaranteed))\b/i;
const SENSITIVE_RE = /\b(seguro social|social security|ssn|n[uú]mero de (?:la )?tarjeta|card number|cvv|contrase[nñ]a|password|routing number|n[uú]mero de cuenta bancaria|bank account number)\b/i;

/** Revisa el borrador del agente antes de mandarlo. */
export function checkOutbound(draft: string, maxChars = 1200): Violation[] {
  const v: Violation[] = [];
  const prices = draft.match(PRICE_RE) || [];
  if (prices.some(p => !ALLOWED_PRICES.includes(p.replace(/\s/g, '').replace(/^US/, '').replace(/\.00$/, '')))) v.push('price');
  if (PROMISE_RE.test(draft)) v.push('promise');
  if (SENSITIVE_RE.test(draft)) v.push('sensitive_request');
  if (draft.length > maxChars) v.push('too_long');
  return v;
}

/** Respuesta segura cuando un borrador no pasa los guardrails. */
export function safeFallback(lang: Lang, violations: Violation[]): string {
  if (violations.includes('price')) {
    return lang === 'en'
      ? 'Pricing depends on each case, so German prepares a written quote after a short 20-minute call. Would you like me to set that up? I just need your name and the best email or phone to reach you.'
      : 'El precio depende de cada caso, por eso German prepara una cotización por escrito después de una llamada corta de 20 minutos. ¿Quieres que la agendemos? Solo necesito tu nombre y el email o teléfono donde te contactamos.';
  }
  return lang === 'en'
    ? 'Let me connect you with German so he can give you an exact answer. What is the best email or phone to reach you?'
    : 'Para darte una respuesta exacta, te pongo en contacto con German. ¿Cuál es el mejor email o teléfono para contactarte?';
}

/** Mensaje de divulgación: el usuario sabe que habla con una IA. */
export function disclosure(lang: Lang): string {
  return lang === 'en'
    ? "Hi! I'm all4kloud's virtual assistant (AI). I can tell you about our services and connect you with German, our founder. How can I help?"
    : '¡Hola! Soy el asistente virtual de all4kloud (inteligencia artificial). Te cuento sobre nuestros servicios y te pongo en contacto con German, nuestro fundador. ¿En qué te ayudo?';
}

/** Detecta idioma de forma simple (para el primer mensaje). */
export function guessLang(text: string): Lang {
  const t = ` ${text.toLowerCase()} `;
  const es = [' que ', ' para ', ' hola', ' necesito', ' quiero', ' cuánto', ' cuanto', ' precio', ' negocio', ' gracias', 'ñ', ' mi ', ' tengo', ' una ', ' cómo', ' como '];
  const en = [' the ', ' and ', ' hello', ' hi ', ' need', ' want', ' how ', ' price', ' business', ' thanks', ' my ', ' have ', ' what '];
  const s = es.filter(w => t.includes(w)).length;
  const e = en.filter(w => t.includes(w)).length;
  return e > s ? 'en' : 'es';
}

/** Palabras de baja / alta de mensajes (SMS y WhatsApp). */
export const STOP_WORDS = ['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit', 'baja', 'parar', 'alto', 'detener'];
export const START_WORDS = ['start', 'unstop', 'yes', 'alta'];
export const isStop = (t: string) => STOP_WORDS.includes(t.trim().toLowerCase());
export const isStart = (t: string) => START_WORDS.includes(t.trim().toLowerCase());
