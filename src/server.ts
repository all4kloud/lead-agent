import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { config } from './config.js';
import { anthropicLlm, type EngineDeps, type Llm } from './engine.js';
import { MemoryStore, SupabaseStore, type Store } from './store.js';
import { webRoutes } from './channels/web.js';
import { twilioRoutes } from './channels/twilio.js';

export function buildApp(deps: EngineDeps) {
  const app = new Hono();
  app.use('*', logger());
  // Cloud Run reserva las rutas que terminan en "z" (/healthz da 404 en el dominio público)
  app.get('/health', c => c.json({ ok: true }));
  app.get('/healthz', c => c.json({ ok: true }));
  app.route('/', webRoutes(deps));
  app.route('/twilio', twilioRoutes(deps));
  return app;
}

export function storeFromEnv(): Store {
  const url = config.supabaseUrl(), key = config.supabaseKey();
  if (url && key) return new SupabaseStore(url, key);
  console.warn('[lead-agent] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY no configurados: usando memoria (se pierde al reiniciar)');
  return new MemoryStore();
}

export function llmFromEnv(): Llm {
  const key = config.anthropicKey();
  if (key) return anthropicLlm(key);
  console.warn('[lead-agent] ANTHROPIC_API_KEY no configurada: el chat responde un mensaje fijo');
  return {
    async create() {
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'El asistente aún no está configurado. Escríbenos a info@all4kloud.com.', citations: null }] } as never;
    },
  };
}
