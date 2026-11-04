import { TorClient } from 'anyone-client/TorClient.js';
import { abortRace } from 'anyone-client/abort.js';
import { Log } from 'anyone-client/Log.js';
import { ensureWasmInitialized, setWasmSourceProvider } from 'anyone-client/wasm.js';
import { relaySocketProvider } from './relay-socket.js';

const requestTimeout = 15_000;
let idleSession;
let idleTimer;
let activeDeadline;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function timeoutError() {
  return failure('wasm-timeout', 'The browser test ran out of time.');
}

function phaseSignal(maxMs) {
  const remaining = activeDeadline - Date.now();
  if (remaining <= 0) throw timeoutError();
  return AbortSignal.timeout(Math.min(remaining, maxMs));
}

setWasmSourceProvider(async () => {
  try {
    const response = await fetch('/wasm-lab/tor_js_bg.wasm?v=' + __WASM_SHA256__, {
      integrity: __WASM_INTEGRITY__,
      signal: phaseSignal(30_000),
    });
    if (!response.ok) throw new Error();
    return await response.arrayBuffer();
  } catch {
    if (Date.now() >= activeDeadline) throw timeoutError();
    throw failure('wasm-download', 'Could not download or verify the browser client.');
  }
});

async function loadSnapshot(cache = 'default') {
  try {
    const response = await fetch('/wasm-lab/bootstrap', { cache, signal: phaseSignal(20_000) });
    if (!response.ok) throw new Error();
    const generation = response.headers.get('X-Lab-Snapshot');
    if (generation !== null && !/^[0-9a-f]{64}$/.test(generation)) throw new Error();
    return { bytes: new Uint8Array(await response.arrayBuffer()), generation };
  } catch {
    if (Date.now() >= activeDeadline) throw timeoutError();
    throw failure('directory', 'Could not download the signed Anyone directory.');
  }
}

function takeSession() {
  clearTimeout(idleTimer);
  const session = idleSession;
  idleSession = undefined;
  return session;
}

function keepSession(session) {
  const remaining = session.expiresAt - performance.now();
  if (remaining <= 0) {
    session.client.close();
    return;
  }
  idleSession = session;
  idleTimer = setTimeout(() => takeSession()?.client.close(), remaining);
}

async function connect(bootstrap) {
  const socketProvider = relaySocketProvider(bootstrap.generation);
  const expiresAt = performance.now() + 75_000;
  const client = new TorClient({
    socketProvider, bootstrap: bootstrap.bytes, storage: null,
    log: new Log({ rawLog() {} }), logLevel: 'error',
  });
  try {
    await abortRace(client.ready(), phaseSignal(30_000), () => new Error('Connection timed out'));
    return { client, expiresAt };
  } catch (error) {
    socketProvider.close();
    client.close();
    if (Date.now() >= activeDeadline) throw timeoutError();
    if (/consensus|authority cert|fast bootstrap/i.test(String(error))) {
      throw failure('directory-check', 'The browser could not validate the signed Anyone directory.');
    }
    throw failure('relay', 'Could not open a connection to the Anyone network.');
  }
}

async function request(session, nonce) {
  const url = 'https://httpbingo.org/anything/' + nonce;
  let result, data;
  try {
    result = await session.client.fetch(url, { signal: phaseSignal(requestTimeout), redirect: 'error' });
    data = await result.json();
  } catch {
    if (Date.now() >= activeDeadline) throw timeoutError();
    throw failure('request', 'The test endpoint did not respond through the Anyone circuit.');
  }
  if (!result.ok || data?.url !== url || typeof data.origin !== 'string' ||
      !/^[0-9a-fA-F:.]{3,45}$/.test(data.origin)) {
    throw failure('response', 'The test endpoint did not return the expected test ID and source IP.');
  }
  return data.origin;
}

async function measure(nonce, progress) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid test ID.');
  const start = performance.now();
  let session = takeSession();
  let bootstrap;
  if (session && session.expiresAt - start < requestTimeout) {
    session.client.close();
    session = undefined;
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const reusedSession = Boolean(session);
    try {
      if (!session) {
        if (!bootstrap) {
          progress('assets');
          [bootstrap] = await Promise.all([
            loadSnapshot(attempt ? 'no-cache' : 'default'),
            ensureWasmInitialized().catch(error => {
              if (['wasm-download', 'wasm-timeout'].includes(error?.code)) throw error;
              throw failure('wasm-runtime', 'This browser could not start the WebAssembly client.');
            }),
          ]);
        }
        progress(attempt ? 'retry' : 'connect');
        session = await connect(bootstrap);
      }
      progress('request');
      const sentAt = performance.now();
      const ip = await request(session, nonce);
      const finishedAt = performance.now();
      keepSession(session);
      return {
        ip, nonce, requestMs: Math.round(finishedAt - sentAt),
        reusedSession, at: new Date().toISOString(), target: 'httpbingo.org',
        transport: 'anyone-browser-wasm',
      };
    } catch (error) {
      session?.client.close();
      session = undefined;
      if (attempt || !['relay', 'request'].includes(error?.code)) throw error;
      if (error.code === 'relay') bootstrap = undefined;
    }
  }
}

self.addEventListener('message', async ({ data: { nonce, deadline } }) => {
  if (activeDeadline !== undefined) return;
  activeDeadline = deadline;
  try {
    const result = await measure(nonce, phase => self.postMessage({ type: 'progress', phase }));
    self.postMessage({ type: 'result', result });
  } catch (error) {
    self.postMessage({ type: 'failure', code: error?.code, message: error?.message });
  } finally {
    activeDeadline = undefined;
  }
});
