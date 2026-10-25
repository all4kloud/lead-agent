# lead-agent — agente de leads de all4kloud

Atiende prospectos 24/7, explica los servicios de all4kloud, consigue sus datos y los deja en **Zoho CRM**, con aviso por email a German. Usa **Claude Haiku 5.5** (rápido y barato) y reglas de seguridad en el código.

| Canal | Estado | Cómo entra |
|---|---|---|
| Chat en el sitio (Wix) | ✅ Listo | `widget.js` + ventana `/chat` |
| Correo | ✅ Activo aparte | Tarea programada "Agente de ventas - correo" (Gmail + Zoho, deja borradores) |
| SMS | ⏳ Código listo, apagado | Twilio → `POST /twilio/sms` (falta número + registro A2P 10DLC) |
| WhatsApp | ⏳ Código listo, apagado | Twilio → `POST /twilio/whatsapp` (falta remitente de WhatsApp aprobado) |
| Facebook / Instagram | 🔜 Fase 3 | Requiere app de Meta y App Review |

## Cómo funciona

```
mensaje → quitar tarjetas/SSN → Claude (con herramientas) → guardrails → respuesta
                                   │
                                   ├─ save_lead ──► Supabase + Zoho CRM (Leads) + email a German
                                   ├─ request_human ──► marca la conversación + email a German
                                   └─ get_booking_link ──► BOOKING_URL
```

**Reglas en el código (no solo en el prompt)** — `src/guardrails.ts`:
- Nunca da precios: cualquier monto distinto de **$100** (Estimates & Invoices) se reemplaza por una respuesta segura y queda registrado en `guardrail_incidents`.
- Nunca promete resultados ni garantías; nunca pide tarjetas, cuentas, SSN o contraseñas.
- Si el usuario escribe una tarjeta (validada con Luhn) o un SSN, se borra **antes** de guardarlo o mandarlo al modelo.
- Se presenta como IA desde el primer mensaje. En SMS/WhatsApp agrega cómo darse de baja; `STOP`/`BAJA` se respeta y queda registrado.
- El consentimiento para contactar se pregunta de forma explícita y se guarda en `consents` (fecha, medio, respuesta del usuario).
- Límite de mensajes por IP y de turnos por conversación.

Lo que el agente "sabe" del negocio está en **`knowledge/all4kloud.md`**: edítalo y redespliega.

## Desarrollo

```bash
npm install
npm run dev        # sin variables: usa memoria y un modelo de mentira
npm test           # 15 pruebas: guardrails, flujo con herramientas, Twilio, chat web
```

## Despliegue (Cloud Run, mismo proyecto que Estimates)

1. **Supabase**: proyecto `lead-agent` con `supabase/migrations/0001_lead_agent.sql`. Copia la *service_role key*.
2. **Claude**: crea una API key en console.anthropic.com (con límite de gasto mensual).
3. **Zoho CRM** (para que el servidor cree leads):
   1. api-console.zoho.com → *Self Client* → *Generate Code* con scope
      `ZohoCRM.modules.leads.ALL,ZohoCRM.modules.notes.CREATE` y duración 10 minutos.
   2. Cambia ese código por un refresh token (PowerShell):
      ```powershell
      Invoke-RestMethod -Method Post -Uri "https://accounts.zoho.com/oauth/v2/token" -Body @{
        grant_type='authorization_code'; client_id='CLIENT_ID'; client_secret='CLIENT_SECRET'; code='CODIGO' }
      ```
      Guarda el `refresh_token` de la respuesta.
4. **GCP**: `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` y luego
   `.\scripts\gcp-setup.ps1 -ProjectId all4kloud-estimates`. Pide cada secreto: lo copias y presionas Enter
   (lo lee del portapapeles; no hay que pegar nada en la terminal).
5. **Variables de GitHub** (Settings → Secrets and variables → Actions → **Variables**):

   | Variable | Valor |
   |---|---|
   | `GCP_PROJECT_ID`, `GCP_REGION`, `WIF_PROVIDER`, `DEPLOY_SA`, `RUNTIME_SA` | las mismas de estimates-saas |
   | `PUBLIC_URL` | `https://agent.all4kloud.net` |
   | `ALLOWED_ORIGINS` | `https://www.all4kloud.net,https://all4kloud.net` |
   | `SUPABASE_URL` | URL del proyecto `lead-agent` |
   | `RESEND_FROM_EMAIL` | `agente@all4kloud.net` |
   | `NOTIFY_EMAIL` | `all4kloud@gmail.com` |
   | `BOOKING_URL` | (opcional) página de citas de Google Calendar |

6. **Dominio** `agent.all4kloud.net`:
   ```powershell
   gcloud beta run domain-mappings create --service lead-agent --domain agent.all4kloud.net --region us-east1 --project all4kloud-estimates
   ```
   y en el DNS de Wix un CNAME `agent` → `ghs.googlehosted.com`.

## Poner el chat en Wix

Wix → **Settings → Custom Code → + Add Custom Code** (requiere plan Premium con dominio):

```html
<script src="https://agent.all4kloud.net/widget.js" data-lang="es" defer></script>
```

- *Add Code to Pages*: **All pages** · *Place Code in*: **Body - end**.
- `data-lang="en"` para la versión en inglés; `data-color="#1b3566"` cambia el color del botón.

## Activar SMS y WhatsApp (Twilio)

1. Compra un número en Twilio y registra la marca y campaña **A2P 10DLC** (uso: atención a clientes y leads; mensajes de ejemplo con el aviso de IA y "Responde BAJA").
2. Number → *Messaging* → **A message comes in**: Webhook `https://agent.all4kloud.net/twilio/sms` (POST).
3. WhatsApp: crea el remitente en Twilio (*Messaging → Senders → WhatsApp senders*) con el mismo número; webhook `https://agent.all4kloud.net/twilio/whatsapp`.
4. Guarda el Auth Token en el secreto `lead-agent-twilio-auth-token` y redespliega. Sin ese secreto, las rutas responden 404.
