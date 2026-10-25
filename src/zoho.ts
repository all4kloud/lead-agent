import { config } from './config.js';
import type { LeadInput } from './store.js';

/**
 * Cliente mínimo de Zoho CRM (API v8) con un refresh token de "Self Client".
 * Scopes necesarios: ZohoCRM.modules.leads.ALL, ZohoCRM.modules.notes.CREATE
 */
let cached: { token: string; expires: number } | null = null;

export const zohoConfigured = () => !!(config.zoho.clientId() && config.zoho.clientSecret() && config.zoho.refreshToken());

async function accessToken(fetchImpl: typeof fetch = fetch) {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const body = new URLSearchParams({
    refresh_token: config.zoho.refreshToken()!, client_id: config.zoho.clientId()!,
    client_secret: config.zoho.clientSecret()!, grant_type: 'refresh_token',
  });
  const r = await fetchImpl(`${config.zoho.accountsUrl}/oauth/v2/token`, { method: 'POST', body });
  const j = await r.json() as { access_token?: string; expires_in?: number; error?: string };
  if (!j.access_token) throw new Error(`Zoho token: ${j.error || r.status}`);
  cached = { token: j.access_token, expires: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function api(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch) {
  const token = await accessToken(fetchImpl);
  const r = await fetchImpl(`${config.zoho.apiUrl}/crm/v8${path}`, {
    ...init, headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (r.status === 204) return null;
  const j = await r.json() as Record<string, unknown>;
  if (!r.ok) throw new Error(`Zoho ${path}: ${r.status} ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

const SOURCE: Record<string, string> = { web: 'Chat web', sms: 'SMS', whatsapp: 'WhatsApp', email: 'Email', messenger: 'Facebook', instagram: 'Instagram' };

/** Crea el lead, o agrega una nota si ya existe uno con ese email o teléfono. Devuelve el id de Zoho. */
export async function upsertLead(lead: LeadInput, summary: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const criteria = lead.email ? `(Email:equals:${lead.email})` : lead.phone ? `(Phone:equals:${lead.phone})` : null;
  if (criteria) {
    const found = await api(`/Leads/search?criteria=${encodeURIComponent(criteria)}`, {}, fetchImpl) as { data?: { id: string }[] } | null;
    const id = found?.data?.[0]?.id;
    if (id) {
      await api('/Notes', { method: 'POST', body: JSON.stringify({ data: [{
        Parent_Id: { module: { api_name: 'Leads' }, id }, Note_Title: `Nuevo contacto por ${SOURCE[lead.channel]}`, Note_Content: summary,
      }] }) }, fetchImpl);
      return id;
    }
  }
  const [first, ...rest] = lead.name.trim().split(/\s+/);
  const created = await api('/Leads', { method: 'POST', body: JSON.stringify({ data: [{
    First_Name: rest.length ? first : undefined,
    Last_Name: rest.length ? rest.join(' ') : first,
    Email: lead.email, Phone: lead.phone, Company: lead.company || 'Particular',
    Lead_Source: SOURCE[lead.channel] || 'Chat web', Lead_Status: 'Not Contacted',
    Description: summary,
  }] }) }, fetchImpl) as { data: { details: { id: string } }[] };
  return created.data[0].details.id;
}
