import { serve } from '@hono/node-server';
import { config } from './config.js';
import { buildApp, llmFromEnv, storeFromEnv } from './server.js';

const app = buildApp({ store: storeFromEnv(), llm: llmFromEnv() });
serve({ fetch: app.fetch, port: config.port, hostname: '0.0.0.0' }, i => console.log(`[lead-agent] escuchando en :${i.port}`));
