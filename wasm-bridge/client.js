import { TorClient } from 'anyone-client/TorClient.js';
import { abortRace } from 'anyone-client/abort.js';
import { MemoryStorage } from 'anyone-client/storage/memory.js';
import { Log } from 'anyone-client/Log.js';
import { ensureWasmInitialized, setWasmSourceProvider } from 'anyone-client/wasm.js';
import { relaySocketProvider } from './relay-socket.js';

const requestTimeout = 15_000;
let idleSession;
let idleTimer;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

setWasmSourceProvider(async () => {
  try {
    const response = await fetch('/wasm-lab/tor_js_bg.wasm?v=' + __WASM_SHA256__, {
      integrity: __WASM_INTEGRITY__,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error();
    return await response.arrayBuffer();
  } catch {
    throw failure('wasm-download', 'Could not download or verify the browser client.');
  }
});

async function loadSnapshot() {
  try {
    const response = await fetch('/wasm-lab/bootstrap', { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error();
    return new Uint8Array(await response.arrayBuffer());
  } catch {
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

window.addEventListener('pagehide', () => takeSession()?.client.close());

async function connect(bootstrap) {
  const socketProvider = relaySocketProvider();
  const expiresAt = performance.now() + 75_000;
  const client = new TorClient({
    socketProvider, bootstrap, storage: new MemoryStorage(),
    log: new Log({ rawLog() {} }), logLevel: 'error',
  });
  try {
    await abortRace(client.ready(), AbortSignal.timeout(30_000), () => new Error('Connection timed out'));
    return { client, expiresAt };
  } catch (error) {
    socketProvider.close();
    client.close();
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
    result = await session.client.fetch(url, { signal: AbortSignal.timeout(requestTimeout), redirect: 'error' });
    data = await result.json();
  } catch {
    throw failure('request', 'The test endpoint did not respond through the Anyone circuit.');
  }
  if (!result.ok || data?.url !== url || typeof data.origin !== 'string' ||
      !/^[0-9a-fA-F:.]{3,45}$/.test(data.origin)) {
    throw failure('response', 'The test endpoint did not return the expected test ID and source IP.');
  }
  return data.origin;
}

async function measure(nonce, progress = () => {}) {
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
            loadSnapshot(),
            ensureWasmInitialized().catch(error => {
              if (error?.code === 'wasm-download') throw error;
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
        ip, nonce, elapsedMs: Math.round(finishedAt - start),
        startupMs: Math.round(sentAt - start), requestMs: Math.round(finishedAt - sentAt),
        reusedSession, at: new Date().toISOString(), target: 'httpbingo.org',
        transport: 'anyone-browser-wasm',
      };
    } catch (error) {
      session?.client.close();
      session = undefined;
      if (attempt || !['relay', 'request'].includes(error?.code)) throw error;
    }
  }
}

window.AnyoneWasmLab = { measure };
