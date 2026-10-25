import { describe, expect, it, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { checkOutbound, guessLang, redactInbound, isStop } from './guardrails.js';
import { handleMessage, startConversation, type Llm } from './engine.js';
import { MemoryStore } from './store.js';
import { twilioSignature, validTwilioSignature } from './channels/twilio.js';
import { buildApp } from './server.js';
import { rateLimited } from './channels/web.js';

type Step = Pick<Anthropic.Message, 'content' | 'stop_reason'>;
const text = (t: string): Step => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t, citations: null }] as never });
const tool = (name: string, input: object, t = ''): Step => ({
  stop_reason: 'tool_use',
  content: [...(t ? [{ type: 'text', text: t, citations: null }] : []), { type: 'tool_use', id: `tu_${name}`, name, input }] as never,
});
/** Modelo simulado: devuelve los pasos en orden y guarda lo que recibió. */
function fakeLlm(steps: Step[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const llm: Llm = { async create(p) { calls.push(structuredClone(p)); return steps.shift() ?? text('ok'); } };
  return { llm, calls };
}

describe('guardrails', () => {
  it('bloquea precios no públicos y deja pasar el de Estimates', () => {
    expect(checkOutbound('Una integración cuesta $2,500 aproximadamente.')).toContain('price');
    expect(checkOutbound('That would be around 1500 dollars.')).toContain('price');
    expect(checkOutbound('Estimates & Invoices cuesta $100 al año con 14 días gratis.')).toEqual([]);
  });
  it('bloquea promesas y pedidos de datos sensibles', () => {
    expect(checkOutbound('Te garantizamos que vas a duplicar tus ventas.')).toContain('promise');
    expect(checkOutbound('Pásame tu número de tarjeta para reservar.')).toContain('sensitive_request');
    expect(checkOutbound('¿Cuál es tu correo para que German te escriba?')).toEqual([]);
  });
  it('elimina tarjetas válidas (Luhn) y SSN del mensaje del usuario, no otros números', () => {
    const r = redactInbound('mi tarjeta 4242 4242 4242 4242 y ssn 123-45-6789, tel 919-337-7561');
    expect(r.text).not.toContain('4242');
    expect(r.text).not.toContain('123-45-6789');
    expect(r.text).toContain('919-337-7561');
    expect(r.redacted.sort()).toEqual(['card', 'ssn']);
  });
  it('detecta idioma y palabras de baja', () => {
    expect(guessLang('Hola, necesito una cotización para mi negocio')).toBe('es');
    expect(guessLang('Hi, I need help with my business website')).toBe('en');
    expect(isStop(' STOP ')).toBe(true);
    expect(isStop('Baja')).toBe(true);
  });
});

describe('motor de conversación', () => {
  let store: MemoryStore;
  beforeEach(() => { store = new MemoryStore(); });

  it('guarda el lead con consentimiento y responde', async () => {
    const { conv } = await startConversation(store, 'web', null, 'es');
    const { llm, calls } = fakeLlm([
      tool('save_lead', { name: 'Ana López', email: 'ANA@example.com', company: 'Ana Cleaning', need: 'Quiere un chat para su web', service: 'agentes_ia', preferred_contact: 'email', consent_contact: true }),
      text('¡Gracias, Ana! German te escribe en menos de un día hábil.'),
    ]);
    const r = await handleMessage(conv, 'Sí, acepto que me escriban a ana@example.com', { store, llm });
    expect(r.text).toContain('Gracias');
    expect(store.leads).toHaveLength(1);
    expect(store.leads[0].email).toBe('ana@example.com');
    expect(store.consents[0]).toMatchObject({ granted: true, contact: 'ana@example.com', channel: 'web' });
    expect(conv.lead_id).toBe(store.leads[0].id);
    // la primera llamada al modelo empieza con el usuario (el saludo no se manda como primer mensaje)
    expect(calls[0].messages[0].role).toBe('user');
    // la segunda incluye el resultado de la herramienta
    const last = calls[1].messages.at(-1)!;
    expect(Array.isArray(last.content) && (last.content[0] as { type: string }).type).toBe('tool_result');
  });

  it('no guarda un lead sin email ni teléfono', async () => {
    const { conv } = await startConversation(store, 'web', null, 'es');
    const { llm, calls } = fakeLlm([
      tool('save_lead', { name: 'Ana', need: 'chat', consent_contact: true }),
      text('¿Me compartes tu email o teléfono?'),
    ]);
    await handleMessage(conv, 'Soy Ana', { store, llm });
    expect(store.leads).toHaveLength(0);
    const result = (calls[1].messages.at(-1)!.content as { content: string }[])[0].content;
    expect(result).toContain('Falta un medio de contacto');
  });

  it('reemplaza una respuesta con precio inventado y registra el incidente', async () => {
    const { conv } = await startConversation(store, 'web', null, 'es');
    const { llm } = fakeLlm([text('Eso te saldría unos $3,000.')]);
    const r = await handleMessage(conv, '¿Cuánto cuesta una integración?', { store, llm });
    expect(r.blocked).toContain('price');
    expect(r.text).toContain('cotización');
    expect(store.incidents).toHaveLength(1);
    expect(store.messages.get(conv.id)!.at(-1)!.content).toBe(r.text);
  });

  it('no manda la tarjeta al modelo ni la guarda', async () => {
    const { conv } = await startConversation(store, 'web', null, 'es');
    const { llm, calls } = fakeLlm([text('Por favor no compartas datos de tarjeta por aquí.')]);
    await handleMessage(conv, 'mi tarjeta es 4242424242424242', { store, llm });
    expect(JSON.stringify(calls[0].messages)).not.toContain('4242424242424242');
    expect(JSON.stringify([...store.messages.values()])).not.toContain('4242424242424242');
  });

  it('pide ayuda humana y marca la conversación', async () => {
    const { conv } = await startConversation(store, 'web', null, 'en');
    const { llm } = fakeLlm([tool('request_human', { reason: 'wants a person' }), text('German will reach out soon.')]);
    await handleMessage(conv, 'I want to talk to a human', { store, llm });
    expect(conv.needs_human).toBe(true);
  });
});

describe('Twilio', () => {
  it('valida la firma y rechaza una alterada', () => {
    const params = { From: '+19195550100', Body: 'Hola', To: '+19195550199' };
    const sig = twilioSignature('secret-token', 'https://agent.example.com/twilio/sms', params);
    expect(validTwilioSignature('secret-token', 'https://agent.example.com/twilio/sms', params, sig)).toBe(true);
    expect(validTwilioSignature('secret-token', 'https://agent.example.com/twilio/sms', { ...params, Body: 'otro' }, sig)).toBe(false);
    expect(validTwilioSignature('secret-token', 'https://agent.example.com/twilio/sms', params, undefined)).toBe(false);
  });

  it('el webhook queda apagado sin TWILIO_AUTH_TOKEN', async () => {
    const app = buildApp({ store: new MemoryStore(), llm: fakeLlm([]).llm });
    const r = await app.request('/twilio/sms', { method: 'POST', body: new URLSearchParams({ From: '+1', Body: 'hi' }) });
    expect(r.status).toBe(404);
  });

  it('SMS: firma válida → respuesta TwiML con aviso de IA; STOP → sin respuesta', async () => {
    process.env.TWILIO_AUTH_TOKEN = 'tok';
    process.env.PUBLIC_URL = 'http://localhost:8080';
    try {
      const store = new MemoryStore();
      const app = buildApp({ store, llm: fakeLlm([text('¿Qué tipo de negocio tienes?')]).llm });
      const send = (Body: string) => {
        const params = { From: '+19195550100', Body };
        const sig = twilioSignature('tok', 'http://localhost:8080/twilio/sms', params);
        return app.request('/twilio/sms', { method: 'POST', body: new URLSearchParams(params), headers: { 'x-twilio-signature': sig } });
      };
      const r1 = await send('Hola, necesito ayuda con mi negocio');
      const x1 = await r1.text();
      expect(x1).toContain('<Message>');
      expect(x1).toContain('IA');
      const r2 = await send('STOP');
      expect(await r2.text()).not.toContain('<Message>');
      expect([...store.conversations.values()][0].opted_out).toBe(true);
      expect(store.consents.at(-1)).toMatchObject({ granted: false });
    } finally {
      delete process.env.TWILIO_AUTH_TOKEN;
    }
  });
});

describe('chat web', () => {
  it('inicia, conversa y rechaza conversaciones inexistentes', async () => {
    const store = new MemoryStore();
    const app = buildApp({ store, llm: fakeLlm([text('¿En qué tipo de negocio trabajas?')]).llm });
    const post = (path: string, body: object) => app.request(path, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '10.0.0.' + Math.random() },
    });
    const s = await (await post('/api/chat/start', { lang: 'es' })).json() as { conversationId: string; greeting: string };
    expect(s.greeting).toContain('inteligencia artificial');
    const r = await (await post('/api/chat', { conversationId: s.conversationId, message: 'Hola' })).json() as { reply: string };
    expect(r.reply).toContain('negocio');
    expect((await post('/api/chat', { conversationId: '00000000-0000-4000-8000-000000000000', message: 'x' })).status).toBe(404);
    expect((await post('/api/chat', { conversationId: 'nope', message: 'x' })).status).toBe(400);
  });

  it('sirve el widget y la ventana con frame-ancestors restringido', async () => {
    const app = buildApp({ store: new MemoryStore(), llm: fakeLlm([]).llm });
    expect(await (await app.request('/widget.js')).text()).toContain('/chat?lang=');
    const page = await app.request('/chat?lang=en');
    expect(page.headers.get('content-security-policy')).toContain('frame-ancestors');
    expect(await page.text()).toContain('Virtual assistant (AI)');
  });

  it('limita mensajes por IP', () => {
    const now = Date.now();
    let blocked = false;
    for (let i = 0; i < 13; i++) blocked = rateLimited('1.2.3.4', 12, now + i);
    expect(blocked).toBe(true);
    expect(rateLimited('1.2.3.4', 12, now + 61_000)).toBe(false);
  });
});
