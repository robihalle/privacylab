import test from 'node:test';
import assert from 'node:assert/strict';
import {privacyApi} from '../lib/privacy-api.mjs';
const origin='https://lab.example';
const nonce='12345678-1234-1234-1234-123456789abc';
const req=(body={nonce},headers={})=>new Request(origin+'/api/lab/test',{method:'POST',headers:{Origin:origin,...headers},body:JSON.stringify(body)});
const env={ANYONE_GATEWAY_URL:'https://gateway.example',ANYONE_GATEWAY_TOKEN:'test-secret'};
test('unconfigured gateway fails closed',async()=>{let r=await privacyApi(req(),{});assert.equal(r.status,503)});
test('cross origin denied',async()=>{let r=await privacyApi(req({nonce},{Origin:'https://other.example'}),env);assert.equal(r.status,403)});
test('malformed ID rejected',async()=>{let r=await privacyApi(req({nonce:'bad'}),env);assert.equal(r.status,400)});
test('no cleartext gateway',async()=>{let r=await privacyApi(req(),{...env,ANYONE_GATEWAY_URL:'http://gateway.example'});assert.equal(r.status,503)});
test('validated gateway response strips extras and forwards only nonce',async()=>{const previous=globalThis.fetch;try{globalThis.fetch=async(url,opts)=>{assert.equal(String(url),'https://gateway.example/v1/test');assert.equal(opts.headers.Authorization,'Bearer test-secret');assert.equal(opts.body,JSON.stringify({nonce}));return Response.json({nonce,ip:'203.0.113.4',elapsedMs:25,transport:'anyone-rust-socks5h',secret:'must-not-leak'})};const r=await privacyApi(req(),env);const data=await r.json();assert.equal(r.status,200);assert.equal(data.secret,undefined);assert.equal(data.ip,'203.0.113.4')}finally{globalThis.fetch=previous}});
test('echo mismatch fails closed',async()=>{const previous=globalThis.fetch;try{globalThis.fetch=async()=>Response.json({nonce:'wrong',ip:'203.0.113.4',elapsedMs:25,transport:'anyone-rust-socks5h'});assert.equal((await privacyApi(req(),env)).status,502)}finally{globalThis.fetch=previous}});

test('the LXC API uses its canonical browser origin and the fixed internal gateway', async () => {
  const publicOrigin = 'https://lab.example';
  const request = new Request('http://web:3000/api/lab/test', {
    method: 'POST',
    headers: {Origin: publicOrigin},
    body: JSON.stringify({nonce}),
  });
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(String(url), 'http://gateway:8080/v1/test');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      return Response.json({nonce, ip: '203.0.113.4', elapsedMs: 25, transport: 'anyone-rust-socks5h'});
    };
    const response = await privacyApi(
      request,
      {...env, ANYONE_GATEWAY_URL: 'http://gateway:8080'},
      {allowInternalGateway: true, publicOrigin},
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ip, '203.0.113.4');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('the LXC mode rejects other HTTP gateways and unexpected origins', async () => {
  const options = {allowInternalGateway: true, publicOrigin: origin};
  const local = {...env, ANYONE_GATEWAY_URL: 'http://gateway:8080'};
  assert.equal((await privacyApi(req({nonce}, {Origin: 'http://web:3000'}), local, options)).status, 403);
  assert.equal((await privacyApi(req(), {...local, ANYONE_GATEWAY_URL: 'http://gateway:8081'}, options)).status, 503);
  assert.equal((await privacyApi(req(), local)).status, 503);
});

test('JSON null returns a validation error', async () => {
  assert.equal((await privacyApi(req(null), env)).status, 400);
});

test('browser WASM is opt-in and advertised only by the LXC API', async () => {
  const status = new Request(origin + '/api/lab/status');
  const enabled = {...env, ANYONE_WASM_ENABLED: '1'};
  const options = {allowInternalGateway: true};
  assert.equal((await (await privacyApi(status, env, options)).json()).wasm, false);
  assert.equal((await (await privacyApi(status, enabled)).json()).wasm, false);
  assert.equal((await (await privacyApi(status, enabled, options)).json()).wasm, true);
});
