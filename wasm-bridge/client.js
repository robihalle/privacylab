import { TorClient } from 'anyone-client/TorClient.js';
import { MemoryStorage } from 'anyone-client/storage/memory.js';
import { Log } from 'anyone-client/Log.js';
import { setWasmSourceProvider } from 'anyone-client/wasm.js';
import { relaySocketProvider } from './relay-socket.js';

setWasmSourceProvider(async () => {
  const response = await fetch('/wasm-lab/tor_js_bg.wasm', { signal: AbortSignal.timeout(35_000) });
  if (!response.ok) throw new Error('The browser client could not be downloaded.');
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== __WASM_SHA256__) throw new Error('The browser client did not match its expected checksum.');
  return bytes;
});

async function measure(nonce) {
  if (!/^[a-f0-9-]{36}$/.test(nonce)) throw new Error('Invalid test ID.');
  const start = performance.now();
  const response = await fetch('/wasm-lab/bootstrap', {
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error('The signed Anyone directory is temporarily unavailable.');
  const bootstrap = new Uint8Array(await response.arrayBuffer());
  const socketProvider = relaySocketProvider();
  const client = new TorClient({
    socketProvider, bootstrap, storage: new MemoryStorage(),
    log: new Log({ rawLog() {} }), logLevel: 'error',
  });
  const url = 'https://httpbingo.org/anything/' + nonce;
  try {
    const result = await client.fetch(url, { signal: AbortSignal.timeout(85_000), redirect: 'error' });
    const data = await result.json();
    if (!result.ok || data.url !== url || typeof data.origin !== 'string' ||
        !/^[0-9a-fA-F:.]{3,45}$/.test(data.origin)) {
      throw new Error('The test endpoint did not return the expected test ID and source IP.');
    }
    return {
      ip: data.origin, nonce, elapsedMs: Math.round(performance.now() - start),
      at: new Date().toISOString(), target: 'httpbingo.org', transport: 'anyone-browser-wasm',
    };
  } finally {
    socketProvider.close();
    client.close();
  }
}

window.AnyoneWasmLab = { measure };
