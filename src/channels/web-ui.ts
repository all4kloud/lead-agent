/** Botón flotante para el sitio (Wix): abre el chat en un iframe. Sin dependencias. */
export function widgetScript(base: string) {
  return `(function(){
  if (window.__a4kChat) return; window.__a4kChat = true;
  var s = document.currentScript; var lang = (s && s.getAttribute('data-lang')) || ((navigator.language||'es').slice(0,2)==='en'?'en':'es');
  var color = (s && s.getAttribute('data-color')) || '#1b3566';
  var label = lang==='en' ? 'Chat with us' : 'Escríbenos';
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', label); btn.title = label;
  btn.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:0;cursor:pointer;background:'+color+';box-shadow:0 6px 20px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center';
  btn.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var frame = null;
  btn.onclick = function(){
    if (!frame) {
      frame = document.createElement('iframe');
      frame.src = '${base}/chat?lang=' + lang; frame.title = label;
      frame.style.cssText = 'position:fixed;right:20px;bottom:92px;z-index:2147483000;width:min(380px,calc(100vw - 40px));height:min(560px,calc(100vh - 120px));border:0;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);background:#fff';
      document.body.appendChild(frame);
    } else { frame.style.display = frame.style.display==='none' ? 'block' : 'none'; }
  };
  document.body.appendChild(btn);
})();`;
}

/** Ventana del chat. */
export function chatPage(lang: 'es' | 'en') {
  const t = lang === 'en'
    ? { title: 'all4kloud', sub: 'Virtual assistant (AI)', ph: 'Type your message…', send: 'Send', err: 'Connection problem. Try again.', note: 'AI assistant. Don’t share card or account numbers here.' }
    : { title: 'all4kloud', sub: 'Asistente virtual (IA)', ph: 'Escribe tu mensaje…', send: 'Enviar', err: 'Problema de conexión. Intenta de nuevo.', note: 'Asistente con IA. No compartas números de tarjeta ni de cuenta aquí.' };
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<style>
:root{--navy:#1b3566;--teal:#1f9a9a;--bg:#f4f6fa;--ink:#14213a;--muted:#5b6b85}
*{box-sizing:border-box}html,body{margin:0;height:100%;font:15px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:var(--ink);background:#fff}
.wrap{display:flex;flex-direction:column;height:100%}
header{background:var(--navy);color:#fff;padding:14px 16px}header b{font-size:16px}header div{font-size:12px;opacity:.8}
#log{flex:1;overflow-y:auto;padding:14px;background:var(--bg);display:flex;flex-direction:column;gap:8px}
.m{max-width:85%;padding:9px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word}
.a{background:#fff;border:1px solid #e3e8f0;align-self:flex-start;border-bottom-left-radius:4px}
.u{background:var(--teal);color:#fff;align-self:flex-end;border-bottom-right-radius:4px}
.typing{color:var(--muted);font-size:13px;align-self:flex-start}
form{display:flex;gap:8px;padding:10px;border-top:1px solid #e3e8f0}
textarea{flex:1;resize:none;border:1px solid #cfd8e6;border-radius:10px;padding:9px 10px;font:inherit;height:42px;max-height:110px}
button{background:var(--navy);color:#fff;border:0;border-radius:10px;padding:0 14px;font-weight:600;cursor:pointer}
button:disabled{opacity:.5}.note{font-size:11px;color:var(--muted);padding:0 12px 8px;text-align:center}
</style></head><body><div class="wrap">
<header><b>${t.title}</b><div>${t.sub}</div></header>
<div id="log" aria-live="polite"></div>
<form id="f"><textarea id="q" placeholder="${t.ph}" maxlength="1500" aria-label="${t.ph}"></textarea><button id="b">${t.send}</button></form>
<div class="note">${t.note}</div></div>
<script>
(function(){
var lang=${JSON.stringify(lang)}, log=document.getElementById('log'), f=document.getElementById('f'), q=document.getElementById('q'), b=document.getElementById('b');
var key='a4k_conv_'+lang, conv=null; try{conv=sessionStorage.getItem(key)}catch(e){}
function add(text,who){var d=document.createElement('div');d.className='m '+who;d.textContent=text;log.appendChild(d);log.scrollTop=log.scrollHeight;return d}
function post(path,body){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()})}
function start(){return post('/api/chat/start',{lang:lang}).then(function(r){conv=r.conversationId;try{sessionStorage.setItem(key,conv)}catch(e){}add(r.greeting,'a')})}
(conv?Promise.resolve(add(${JSON.stringify(lang === 'en' ? 'Welcome back! How can I help?' : '¡Hola de nuevo! ¿En qué te ayudo?')},'a')):start()).catch(function(){add(${JSON.stringify(t.err)},'a')});
q.addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();f.requestSubmit()}});
f.addEventListener('submit',function(e){e.preventDefault();var text=q.value.trim();if(!text||!conv)return;
  add(text,'u');q.value='';b.disabled=true;var w=add('…','typing');
  post('/api/chat',{conversationId:conv,message:text}).then(function(r){w.remove();
    if(r.error==='not_found'){conv=null;try{sessionStorage.removeItem(key)}catch(e){};return start()}
    add(r.reply||${JSON.stringify(t.err)},'a')}).catch(function(){w.remove();add(${JSON.stringify(t.err)},'a')}).finally(function(){b.disabled=false;q.focus()})});
})();
</script></body></html>`;
}
