import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { config } from './config.js';
import { checkOutbound, disclosure, redactInbound, safeFallback, type Lang } from './guardrails.js';
import { upsertLead, zohoConfigured } from './zoho.js';
import { notifyOwner } from './notify.js';
import type { Channel, Conversation, LeadInput, Store } from './store.js';

type MessageParams = Anthropic.MessageCreateParamsNonStreaming;
type MessageResult = Pick<Anthropic.Message, 'content' | 'stop_reason'>;
/** Lo único que el motor necesita del modelo (permite probar sin llamar a la API). */
export interface Llm { create(p: MessageParams): Promise<MessageResult>; }

export function anthropicLlm(apiKey: string): Llm {
  const client = new Anthropic({ apiKey });
  return { create: p => client.messages.create(p) };
}

let knowledgeCache: string | null = null;
export function knowledge(): string {
  if (knowledgeCache === null) {
    try { knowledgeCache = readFileSync(new URL('../knowledge/all4kloud.md', import.meta.url), 'utf8'); }
    catch { knowledgeCache = ''; }
  }
  return knowledgeCache;
}

const SERVICES = ['integraciones', 'agentes_ia', 'ia_segura', 'nube_devops', 'desarrollo', 'soporte_marketing', 'estimates_invoices', 'otro'] as const;

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'save_lead',
    description: 'Guarda al prospecto cuando ya tienes su nombre, lo que necesita y al menos un email o teléfono. Llámala una sola vez por conversación (vuelve a llamarla solo si el prospecto corrige sus datos).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Nombre completo' },
        email: { type: 'string' },
        phone: { type: 'string', description: 'Teléfono con código de área' },
        company: { type: 'string', description: 'Nombre del negocio, si lo dio' },
        need: { type: 'string', description: 'Resumen de 1 a 3 frases de lo que necesita' },
        service: { type: 'string', enum: [...SERVICES] },
        preferred_contact: { type: 'string', enum: ['email', 'phone', 'sms', 'whatsapp'] },
        consent_contact: { type: 'boolean', description: 'true SOLO si el prospecto aceptó de forma explícita que lo contacten por el medio preferido' },
      },
      required: ['name', 'need', 'consent_contact'],
    },
  },
  {
    name: 'get_booking_link',
    description: 'Devuelve el link para agendar la llamada de 20 minutos con German, si existe.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'request_human',
    description: 'Pide que German tome la conversación: el prospecto lo pide, está molesto, o pregunta algo que no puedes responder con la información que tienes.',
    input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

export function systemPrompt(conv: Conversation): string {
  const short = conv.channel === 'sms' || conv.channel === 'whatsapp';
  return `Eres el asistente virtual de all4kloud LLC. Atiendes prospectos por ${conv.channel}. Respondes en ${conv.lang === 'en' ? 'inglés' : 'español'} salvo que el usuario cambie de idioma.

TU OBJETIVO: entender qué necesita el prospecto, explicarle en qué le puede ayudar all4kloud y conseguir sus datos para que German lo contacte (o que agende la llamada de 20 minutos).

REGLAS (obligatorias):
1. Eres una IA y lo dices si te preguntan. No finjas ser German ni una persona.
2. No des precios, rangos ni estimaciones. El único precio público es Estimates & Invoices: $100 al año con 14 días gratis. Todo lo demás se cotiza después de la llamada.
3. No prometas resultados, plazos ni garantías.
4. Nunca pidas datos sensibles: tarjetas, números de cuenta, seguro social, contraseñas. Si el usuario los escribe, dile que no los comparta por aquí.
5. Pide los datos de contacto de forma natural, uno o dos a la vez, solo después de entender la necesidad. Antes de guardar el lead, pregunta explícitamente si acepta que German lo contacte por el medio que prefiere; si dice que no, guarda igual el lead con consent_contact=false.
6. Si el prospecto pide hablar con una persona, está molesto o preguntas algo fuera de lo que sabes, usa request_human.
7. No hables de otros clientes ni de Conectare.
8. Respuestas ${short ? 'muy cortas (máximo 300 caracteres, sin formato)' : 'cortas: 2 a 4 frases, sin listas largas ni markdown'}. Una pregunta a la vez.

ESTADO: ${conv.lead_id ? 'El lead YA está guardado; no lo pidas de nuevo.' : 'Aún no hay lead guardado.'}${conv.needs_human ? ' German ya fue avisado para que tome la conversación.' : ''}
${config.bookingUrl ? 'Hay link de agenda disponible (usa get_booking_link).' : 'No hay link de agenda: German contacta al prospecto directamente.'}

INFORMACIÓN DEL NEGOCIO:
${knowledge()}`;
}

export interface EngineDeps { store: Store; llm: Llm; fetchImpl?: typeof fetch; }

/** Ejecuta una herramienta y devuelve el texto que verá el modelo. */
async function runTool(name: string, input: Record<string, unknown>, conv: Conversation, lastUser: string, deps: EngineDeps): Promise<string> {
  const { store } = deps;
  if (name === 'get_booking_link') {
    return config.bookingUrl ? `Link de agenda: ${config.bookingUrl}` : 'No hay link de agenda; di que German lo contactará en menos de un día hábil.';
  }
  if (name === 'request_human') {
    await store.updateConversation(conv.id, { needs_human: true });
    conv.needs_human = true;
    await notifyOwner(`[Agente] Conversación para atender (${conv.channel})`,
      `Motivo: ${String(input.reason || '')}\nConversación: ${conv.id}\nÚltimo mensaje: ${lastUser}`, deps.fetchImpl);
    return 'German fue avisado. Dile al prospecto que German le escribirá pronto y pide su email o teléfono si aún no los tienes.';
  }
  if (name === 'save_lead') {
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string).trim().slice(0, 300) : undefined);
    const lead: LeadInput = {
      name: s('name') || '', email: s('email')?.toLowerCase(), phone: s('phone'), company: s('company'),
      need: s('need') || '', service: s('service'), preferred_contact: s('preferred_contact'),
      consent_contact: input.consent_contact === true, language: conv.lang, channel: conv.channel,
    };
    if (!lead.name || !lead.need) return 'Faltan datos: pide nombre y qué necesita.';
    if (!lead.email && !lead.phone) return 'Falta un medio de contacto: pide email o teléfono.';
    if (lead.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lead.email)) return 'El email no parece válido: pídelo de nuevo.';

    const summary = `${lead.need}\nServicio: ${lead.service || '-'} · Prefiere: ${lead.preferred_contact || '-'} · Acepta contacto: ${lead.consent_contact ? 'sí' : 'no'} · Idioma: ${lead.language} · Canal: ${lead.channel}`;
    let zohoId: string | null = null;
    if (zohoConfigured()) {
      try { zohoId = await upsertLead(lead, summary, deps.fetchImpl); }
      catch (e) { console.error('[zoho]', e); }
    }
    const leadId = await store.saveLead(conv.id, lead, zohoId);
    const contact = lead.preferred_contact === 'email' ? lead.email : lead.phone || lead.email;
    if (contact) {
      await store.recordConsent({
        conversation_id: conv.id, channel: conv.channel, contact, granted: lead.consent_contact,
        text: `Contacto por ${lead.preferred_contact || 'email'}. Respuesta del usuario: "${lastUser.slice(0, 300)}"`,
      });
    }
    await store.updateConversation(conv.id, { lead_id: leadId });
    conv.lead_id = leadId;
    await notifyOwner(`[Agente] Nuevo lead: ${lead.name}${lead.company ? ` (${lead.company})` : ''}`,
      `${summary}\nEmail: ${lead.email || '-'}\nTeléfono: ${lead.phone || '-'}\nZoho: ${zohoId || 'no guardado'}\nConversación: ${conv.id}`, deps.fetchImpl);
    return 'Lead guardado. Agradece, confirma cómo y cuándo lo contactará German (menos de un día hábil) y ofrece el link de agenda si existe.';
  }
  return `Herramienta desconocida: ${name}`;
}

export interface Reply { text: string; conversation: Conversation; blocked: string[]; }

/**
 * Procesa un mensaje del usuario y devuelve la respuesta del agente.
 * Pasa por: datos sensibles fuera → modelo con herramientas → guardrails → guardar.
 */
export async function handleMessage(conv: Conversation, rawText: string, deps: EngineDeps): Promise<Reply> {
  const { store, llm } = deps;
  const { text, redacted } = redactInbound(rawText.slice(0, config.limits.maxMessageChars));

  if (conv.turns >= config.limits.maxTurnsPerConversation) {
    const t = conv.lang === 'en' ? 'Thanks for chatting! German will follow up with you directly.' : '¡Gracias por la conversación! German seguirá contigo directamente.';
    return { text: t, conversation: conv, blocked: [] };
  }

  await store.addMessage(conv.id, { role: 'user', content: text });
  const history = await store.listMessages(conv.id, 30);
  // la API espera que la conversación empiece con el usuario: el saludo inicial va como contexto
  while (history.length && history[0].role === 'assistant') history.shift();
  const messages: Anthropic.MessageParam[] = history.map(m => ({ role: m.role, content: m.content }));
  if (redacted.length) {
    messages.push({ role: 'assistant', content: '(nota interna: el usuario escribió un dato sensible que fue eliminado; pídele que no lo comparta por aquí)' });
    messages.push({ role: 'user', content: '(continúa)' });
  }

  let draft = '';
  for (let i = 0; i < 4; i++) {
    const res = await llm.create({ model: config.model, max_tokens: 600, system: systemPrompt(conv), tools: TOOLS, messages });
    const textOut = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map(b => b.text).join('\n').trim();
    const calls = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) { draft = textOut; break; }
    messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const call of calls) {
      let out: string;
      try { out = await runTool(call.name, (call.input || {}) as Record<string, unknown>, conv, text, deps); }
      catch (e) { console.error('[tool]', call.name, e); out = 'Error interno al guardar; dile al prospecto que German lo contactará y sigue.'; }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out });
    }
    messages.push({ role: 'user', content: results });
    draft = textOut;
  }

  const maxChars = conv.channel === 'sms' || conv.channel === 'whatsapp' ? 480 : 1200;
  const violations = draft ? checkOutbound(draft, maxChars) : ['too_long' as const];
  let final = draft;
  if (violations.length) {
    await store.logIncident({ conversation_id: conv.id, kinds: violations, draft: draft.slice(0, 2000) });
    final = safeFallback(conv.lang, violations);
  }
  await store.addMessage(conv.id, { role: 'assistant', content: final });
  await store.updateConversation(conv.id, { turns: conv.turns + 1 });
  conv.turns += 1;
  return { text: final, conversation: conv, blocked: violations };
}

/** Crea la conversación y devuelve el saludo con la divulgación de IA. */
export async function startConversation(store: Store, channel: Channel, externalId: string | null, lang: Lang) {
  const conv = await store.createConversation({ channel, external_id: externalId, lang });
  const greeting = disclosure(lang);
  await store.addMessage(conv.id, { role: 'assistant', content: greeting });
  return { conv, greeting };
}
