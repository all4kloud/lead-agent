import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../config.js';
import { handleMessage, startConversation, type EngineDeps } from '../engine.js';
import { chatPage, widgetScript } from './web-ui.js';

/** Límite simple por IP en memoria (una instancia de Cloud Run; suficiente para el piloto). */
const hits = new Map<string, number[]>();
export function rateLimited(ip: string, perMinute = config.limits.messagesPerMinutePerIp, now = Date.now()) {
  const recent = (hits.get(ip) || []).filter(t => now - t < 60_000);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60_000)) hits.delete(k);
  return recent.length > perMinute;
}

const ipOf = (c: import('hono').Context) =>
  (c.req.header('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

const StartBody = z.object({ lang: z.enum(['es', 'en']).default('es') });
const ChatBody = z.object({ conversationId: z.string().uuid(), message: z.string().min(1).max(config.limits.maxMessageChars) });

export function webRoutes(deps: EngineDeps) {
  const app = new Hono();

  // script que el sitio de Wix carga: dibuja el botón y abre el chat en un iframe
  app.get('/widget.js', c => c.body(widgetScript(config.publicUrl), 200, {
    'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300',
  }));

  // la ventana del chat (vive en nuestro dominio; solo se puede incrustar desde los orígenes permitidos)
  app.get('/chat', c => {
    const lang = c.req.query('lang') === 'en' ? 'en' : 'es';
    return c.html(chatPage(lang), 200, {
      'Content-Security-Policy': `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'self' ${config.allowedOrigins.join(' ')}`,
      'X-Content-Type-Options': 'nosniff',
    });
  });

  app.post('/api/chat/start', async c => {
    if (rateLimited(ipOf(c))) return c.json({ error: 'rate_limited' }, 429);
    const body = StartBody.safeParse(await c.req.json().catch(() => ({})));
    const lang = body.success ? body.data.lang : 'es';
    const { conv, greeting } = await startConversation(deps.store, 'web', null, lang);
    return c.json({ conversationId: conv.id, greeting });
  });

  app.post('/api/chat', async c => {
    if (rateLimited(ipOf(c))) return c.json({ error: 'rate_limited' }, 429);
    const parsed = ChatBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'bad_request' }, 400);
    const conv = await deps.store.getConversation(parsed.data.conversationId);
    if (!conv || conv.channel !== 'web') return c.json({ error: 'not_found' }, 404);
    try {
      const reply = await handleMessage(conv, parsed.data.message, deps);
      return c.json({ reply: reply.text });
    } catch (e) {
      console.error('[chat]', e);
      const t = conv.lang === 'en'
        ? 'Sorry, something went wrong on our side. You can also email all4kloud@gmail.com.'
        : 'Perdón, tuvimos un problema. También puedes escribir a all4kloud@gmail.com.';
      return c.json({ reply: t }, 200);
    }
  });

  return app;
}
