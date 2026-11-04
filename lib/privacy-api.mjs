const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
export async function privacyApi(request, env, {allowInternalGateway = false, publicOrigin = ""} = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/lab/')) return null;
  const configured = Boolean(env.ANYONE_GATEWAY_URL && env.ANYONE_GATEWAY_TOKEN);
  if (url.pathname === '/api/lab/status' && request.method === 'GET') return json({configured, transport:'native-rust-gateway', wasm:false});
  if (url.pathname !== '/api/lab/test' || request.method !== 'POST') return json({error:'Nicht gefunden.'},404);
  if (request.headers.get('Origin') !== (publicOrigin || url.origin)) return json({error:'Ungültiger Ursprung.'},403);
  if (!configured) return json({error:'Das Anyone-Gateway ist noch nicht verbunden.'},503);
  let body;
  try { const raw = await request.text(); if(raw.length > 256) return json({error:'Anfrage zu groß.'},413); body = JSON.parse(raw); } catch { return json({error:'Ungültige Anfrage.'},400); }
  if (typeof body?.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(body.nonce)) return json({error:'Ungültige Testkennung.'},400);
  let gateway;
  try {
    gateway = new URL(env.ANYONE_GATEWAY_URL);
    // The LXC stack also permits its fixed, unpublished Docker service.
    const internal = allowInternalGateway && gateway.href === 'http://gateway:8080/';
    if ((!internal && gateway.protocol !== 'https:') || gateway.username || gateway.password) throw Error();
  } catch { return json({error:'Gateway-Konfiguration ungültig.'},503); }
  try {
    const start = performance.now();
    const response = await fetch(new URL('/v1/test',gateway), {method:'POST', redirect:'error', headers:{'Content-Type':'application/json','Authorization':`Bearer ${env.ANYONE_GATEWAY_TOKEN}`}, body:JSON.stringify({nonce:body.nonce}), signal:AbortSignal.timeout(45000)});
    if (!response.ok) return json({error:'Das Gateway konnte den Netzwerktest nicht abschließen. Bitte später erneut versuchen.'},502);
    const data = await response.json();
    if (data.nonce !== body.nonce || data.transport !== 'anyone-rust-socks5h' || typeof data.ip !== 'string' || !/^[0-9a-fA-F:.]{3,45}$/.test(data.ip) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return json({error:'Die Gateway-Antwort konnte nicht geprüft werden.'},502);
    return json({ip:data.ip, nonce:body.nonce, elapsedMs:Math.round(data.elapsedMs), gatewayRoundtripMs:Math.round(performance.now()-start), target:'httpbingo.org', transport:data.transport, at:new Date().toISOString(), verification:'gateway-reported'});
  } catch { return json({error:'Das Anyone-Gateway antwortet nicht rechtzeitig oder ist nicht erreichbar.'},502); }
}
