/** Variables de entorno. Vacío o "NOT_SET" = no configurado (igual que en estimates-saas). */
export function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v && v !== 'NOT_SET' ? v : undefined;
}

export const config = {
  port: Number(env('PORT') || 8080),
  publicUrl: (env('PUBLIC_URL') || 'http://localhost:8080').replace(/\/$/, ''),
  // orígenes que pueden incrustar el chat (sitio de Wix). Separados por coma.
  allowedOrigins: (env('ALLOWED_ORIGINS') || 'https://www.all4kloud.net,https://all4kloud.net')
    .split(',').map(s => s.trim()).filter(Boolean),

  anthropicKey: () => env('ANTHROPIC_API_KEY'),
  model: env('ANTHROPIC_MODEL') || 'claude-haiku-5-5',

  supabaseUrl: () => env('SUPABASE_URL'),
  supabaseKey: () => env('SUPABASE_SERVICE_ROLE_KEY'),

  zoho: {
    clientId: () => env('ZOHO_CLIENT_ID'),
    clientSecret: () => env('ZOHO_CLIENT_SECRET'),
    refreshToken: () => env('ZOHO_REFRESH_TOKEN'),
    accountsUrl: env('ZOHO_ACCOUNTS_URL') || 'https://accounts.zoho.com',
    apiUrl: env('ZOHO_API_URL') || 'https://www.zohoapis.com',
  },

  resendKey: () => env('RESEND_API_KEY'),
  resendFrom: env('RESEND_FROM_EMAIL') || 'agente@all4kloud.net',
  notifyEmail: env('NOTIFY_EMAIL') || 'all4kloud@gmail.com',

  bookingUrl: env('BOOKING_URL'),   // página de citas (Google Calendar u otra). Opcional.

  twilio: {
    authToken: () => env('TWILIO_AUTH_TOKEN'),   // sin esto, los webhooks de SMS/WhatsApp quedan apagados
  },

  limits: {
    messagesPerMinutePerIp: Number(env('RATE_LIMIT_PER_MIN') || 12),
    maxTurnsPerConversation: Number(env('MAX_TURNS') || 40),
    maxMessageChars: 1500,
  },
};
