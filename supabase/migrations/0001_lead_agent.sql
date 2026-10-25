-- =====================================================================
--  Agente de leads de all4kloud: conversaciones, mensajes, leads,
--  consentimientos (TCPA) e incidentes de guardrails.
--  Solo el servidor accede (service role). RLS activo y sin políticas:
--  la API pública (anon/authenticated) no puede leer ni escribir nada.
-- =====================================================================
create table public.conversations (
  id           uuid primary key default gen_random_uuid(),
  channel      text not null check (channel in ('web','sms','whatsapp','email','messenger','instagram')),
  external_id  text,                       -- teléfono (sms/whatsapp); null en web
  lang         text not null default 'es' check (lang in ('es','en')),
  lead_id      uuid,
  needs_human  boolean not null default false,
  opted_out    boolean not null default false,
  turns        int not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index on public.conversations (channel, external_id, created_at desc);

create table public.messages (
  id              bigint generated always as identity primary key,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user','assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index on public.messages (conversation_id, created_at);

create table public.leads (
  id                uuid primary key default gen_random_uuid(),
  conversation_id   uuid references public.conversations(id) on delete set null,
  zoho_id           text,
  name              text not null,
  email             text,
  phone             text,
  company           text,
  need              text not null,
  service           text,
  preferred_contact text,
  consent_contact   boolean not null default false,
  language          text not null,
  channel           text not null,
  created_at        timestamptz not null default now()
);
alter table public.conversations add constraint conversations_lead_fk foreign key (lead_id) references public.leads(id) on delete set null;

-- registro defendible del consentimiento: quién, por qué medio, qué respondió y cuándo
create table public.consents (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.conversations(id) on delete set null,
  channel         text not null,
  contact         text not null,
  granted         boolean not null,
  text            text not null,
  created_at      timestamptz not null default now()
);
create index on public.consents (contact, created_at desc);

-- borradores bloqueados por los guardrails (para revisar y mejorar el prompt)
create table public.guardrail_incidents (
  id              bigint generated always as identity primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  kinds           text[] not null,
  draft           text not null,
  created_at      timestamptz not null default now()
);

alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.leads               enable row level security;
alter table public.consents            enable row level security;
alter table public.guardrail_incidents enable row level security;
revoke all on public.conversations, public.messages, public.leads, public.consents, public.guardrail_incidents from anon, authenticated;
