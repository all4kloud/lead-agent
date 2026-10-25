import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { Lang } from './guardrails.js';

export type Channel = 'web' | 'sms' | 'whatsapp' | 'email' | 'messenger' | 'instagram';

export interface Conversation {
  id: string;
  channel: Channel;
  external_id: string | null;   // teléfono (sms/whatsapp) o id de sesión del navegador
  lang: Lang;
  lead_id: string | null;
  needs_human: boolean;
  opted_out: boolean;
  turns: number;
  created_at: string;
}

export interface Msg { role: 'user' | 'assistant'; content: string; }

export interface LeadInput {
  name: string; email?: string; phone?: string; company?: string;
  need: string; service?: string; preferred_contact?: string;
  consent_contact: boolean; language: Lang; channel: Channel;
}

export interface Store {
  createConversation(c: { channel: Channel; external_id: string | null; lang: Lang }): Promise<Conversation>;
  getConversation(id: string): Promise<Conversation | null>;
  findByExternal(channel: Channel, externalId: string): Promise<Conversation | null>;
  updateConversation(id: string, patch: Partial<Omit<Conversation, 'id'>>): Promise<void>;
  addMessage(conversationId: string, m: Msg): Promise<void>;
  listMessages(conversationId: string, limit: number): Promise<Msg[]>;
  saveLead(conversationId: string, lead: LeadInput, zohoId: string | null): Promise<string>;
  recordConsent(c: { conversation_id: string; channel: Channel; contact: string; granted: boolean; text: string }): Promise<void>;
  logIncident(c: { conversation_id: string; kinds: string[]; draft: string }): Promise<void>;
}

/** Para pruebas y desarrollo local sin base de datos. */
export class MemoryStore implements Store {
  conversations = new Map<string, Conversation>();
  messages = new Map<string, Msg[]>();
  leads: (LeadInput & { id: string; conversation_id: string; zoho_id: string | null })[] = [];
  consents: { conversation_id: string; channel: Channel; contact: string; granted: boolean; text: string }[] = [];
  incidents: { conversation_id: string; kinds: string[]; draft: string }[] = [];

  async createConversation(c: { channel: Channel; external_id: string | null; lang: Lang }) {
    const conv: Conversation = { id: randomUUID(), ...c, lead_id: null, needs_human: false, opted_out: false, turns: 0, created_at: new Date().toISOString() };
    this.conversations.set(conv.id, conv);
    return conv;
  }
  async getConversation(id: string) { return this.conversations.get(id) ?? null; }
  async findByExternal(channel: Channel, externalId: string) {
    return [...this.conversations.values()].find(c => c.channel === channel && c.external_id === externalId) ?? null;
  }
  async updateConversation(id: string, patch: Partial<Conversation>) {
    const c = this.conversations.get(id); if (c) Object.assign(c, patch);
  }
  async addMessage(id: string, m: Msg) { this.messages.set(id, [...(this.messages.get(id) || []), m]); }
  async listMessages(id: string, limit: number) { return (this.messages.get(id) || []).slice(-limit); }
  async saveLead(conversation_id: string, lead: LeadInput, zoho_id: string | null) {
    const id = randomUUID(); this.leads.push({ ...lead, id, conversation_id, zoho_id }); return id;
  }
  async recordConsent(c: MemoryStore['consents'][number]) { this.consents.push(c); }
  async logIncident(c: MemoryStore['incidents'][number]) { this.incidents.push(c); }
}

/** Producción: Supabase (Postgres). Usa la service role: solo corre en el servidor. */
export class SupabaseStore implements Store {
  private db: SupabaseClient;
  constructor(url: string, key: string) {
    this.db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  private check<T>(r: { data: T; error: { message: string } | null }): T {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  }
  async createConversation(c: { channel: Channel; external_id: string | null; lang: Lang }) {
    return this.check(await this.db.from('conversations').insert(c).select('*').single()) as Conversation;
  }
  async getConversation(id: string) {
    return this.check(await this.db.from('conversations').select('*').eq('id', id).maybeSingle()) as Conversation | null;
  }
  async findByExternal(channel: Channel, externalId: string) {
    return this.check(await this.db.from('conversations').select('*').eq('channel', channel).eq('external_id', externalId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle()) as Conversation | null;
  }
  async updateConversation(id: string, patch: Partial<Conversation>) {
    this.check(await this.db.from('conversations').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id));
  }
  async addMessage(conversation_id: string, m: Msg) {
    this.check(await this.db.from('messages').insert({ conversation_id, ...m }));
  }
  async listMessages(conversation_id: string, limit: number) {
    const rows = this.check(await this.db.from('messages').select('role, content').eq('conversation_id', conversation_id)
      .order('created_at', { ascending: false }).limit(limit)) as Msg[];
    return rows.reverse();
  }
  async saveLead(conversation_id: string, lead: LeadInput, zoho_id: string | null) {
    const row = this.check(await this.db.from('leads').insert({ conversation_id, zoho_id, ...lead }).select('id').single()) as { id: string };
    return row.id;
  }
  async recordConsent(c: { conversation_id: string; channel: Channel; contact: string; granted: boolean; text: string }) {
    this.check(await this.db.from('consents').insert(c));
  }
  async logIncident(c: { conversation_id: string; kinds: string[]; draft: string }) {
    this.check(await this.db.from('guardrail_incidents').insert(c));
  }
}
