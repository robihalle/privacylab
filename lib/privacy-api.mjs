const json = (body, status = 200) => new Response(JSON.stringify(body), {status, headers: {'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'}});
export async function privacyApi(request, env, {allowInternalGateway = false, publicOrigin = ""} = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/lab/')) return null;
  const configured = Boolean(env.ANYONE_GATEWAY_URL && env.ANYONE_GATEWAY_TOKEN);
  if (url.pathname === '/api/lab/status' && request.method === 'GET') return json({configured, transport:'native-rust-gateway', wasm:allowInternalGateway && env.ANYONE_WASM_ENABLED === '1'});
  if (url.pathname !== '/api/lab/test' || request.method !== 'POST') return json({error:'Not found.'},404);
  if (request.headers.get('Origin') !== (publicOrigin || url.origin)) return json({error:'Invalid request origin.'},403);
  if (!configured) return json({error:'The Anyone gateway is not configured yet.'},503);
  let body;
  try { const raw = await request.text(); if(raw.length > 256) return json({error:'Request body is too large.'},413); body = JSON.parse(raw); } catch { return json({error:'Invalid request.'},400); }
  if (typeof body?.nonce !== 'string' || !/^[a-f0-9-]{36}$/.test(body.nonce)) return json({error:'Invalid test ID.'},400);
  let gateway;
  try {
    gateway = new URL(env.ANYONE_GATEWAY_URL);
    // The LXC stack also permits its fixed, unpublished Docker service.
    const internal = allowInternalGateway && gateway.href === 'http://gateway:8080/';
    if ((!internal && gateway.protocol !== 'https:') || gateway.username || gateway.password) throw Error();
  } catch { return json({error:'Invalid gateway configuration.'},503); }
  try {
    const start = performance.now();
    const response = await fetch(new URL('/v1/test',gateway), {method:'POST', redirect:'error', headers:{'Content-Type':'application/json','Authorization':`Bearer ${env.ANYONE_GATEWAY_TOKEN}`}, body:JSON.stringify({nonce:body.nonce}), signal:AbortSignal.timeout(45000)});
    if (!response.ok) return json({error:'The gateway could not complete the network test. Please try again later.'},502);
    const data = await response.json();
    if (data.nonce !== body.nonce || data.transport !== 'anyone-rust-socks5h' || typeof data.ip !== 'string' || !/^[0-9a-fA-F:.]{3,45}$/.test(data.ip) || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) return json({error:'The gateway response could not be verified.'},502);
    return json({ip:data.ip, nonce:body.nonce, elapsedMs:Math.round(data.elapsedMs), gatewayRoundtripMs:Math.round(performance.now()-start), target:'httpbingo.org', transport:data.transport, at:new Date().toISOString(), verification:'gateway-reported'});
  } catch { return json({error:'The Anyone gateway timed out or is unreachable.'},502); }
}
