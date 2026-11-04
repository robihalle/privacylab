import { ArtiSocket, ArtiSocketProvider } from 'anyone-client/socketProvider.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

export function relaySocketProvider(generation) {
  const sockets = new Set();
  let stopped = false;
  const provider = new ArtiSocketProvider({ strategies: [] });
  provider.close = () => {
    stopped = true;
    for (const socket of sockets) socket.close();
  };

  provider.connect = async (target) => {
    if (stopped || location.protocol !== 'https:') throw new Error('The relay bridge requires HTTPS.');
    const url = new URL('/wasm-lab/relay', location.origin);
    url.protocol = 'wss:';
    url.searchParams.set('target', target);
    if (generation) url.searchParams.set('generation', generation);
    const socket = new WebSocket(url);
    sockets.add(socket);
    socket.binaryType = 'arraybuffer';

    let reader;
    const readable = new ReadableStream({
      start(controller) { reader = controller; },
      cancel() { socket.close(); },
    }, { highWaterMark: 64 });
    let ready = false;
    const open = deferred();
    const closed = deferred();
    const timeout = setTimeout(() => socket.close(), 10_000);
    socket.onmessage = ({ data }) => {
      if (data === 'ready' && !ready) {
        ready = true;
        clearTimeout(timeout);
        open.resolve();
      } else if (ready && data instanceof ArrayBuffer && (reader.desiredSize ?? -64) > -64) {
        reader.enqueue(new Uint8Array(data));
      } else {
        socket.close();
      }
    };
    socket.onclose = ({ wasClean, reason }) => {
      clearTimeout(timeout);
      sockets.delete(socket);
      if (!ready) open.reject(new Error('Could not connect to an Anyone relay.'));
      if (reader.desiredSize !== null) reader.close();
      closed.resolve({ ok: wasClean, reason });
    };
    await open.promise;

    async function closeWrite() {
      if (socket.readyState === WebSocket.OPEN) socket.send('fin');
    }

    const writable = new WritableStream({
      async write(chunk) {
        while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount > 65_536) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        if (socket.readyState !== WebSocket.OPEN) throw new Error('Relay socket closed.');
        socket.send(chunk);
      },
      close: closeWrite,
      abort() { socket.close(); },
    });
    return new ArtiSocket({ readable, writable, closed: closed.promise, closeWrite, close: () => socket.close() });
  };
  return provider;
}
