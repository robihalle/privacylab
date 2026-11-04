const testBudget = 50_000;
let worker;
let pending;
let idleTimer;

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function closeWorker(error) {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = undefined;
  if (pending) {
    clearTimeout(pending.timer);
    pending.reject(error);
    pending = undefined;
  }
}

function startWorker() {
  const instance = new Worker(new URL('./client-worker.js', import.meta.url), { type: 'module' });
  const handleFailure = () => {
    if (worker === instance) {
      closeWorker(failure('wasm-runtime', 'Could not start the background browser client.'));
    }
  };
  instance.addEventListener('error', handleFailure);
  instance.addEventListener('messageerror', handleFailure);
  instance.addEventListener('message', ({ data }) => {
    if (worker !== instance || !pending) return;
    if (Date.now() >= pending.deadline) {
      closeWorker(failure('wasm-timeout', 'The browser test ran out of time.'));
      return;
    }
    if (data.type === 'progress') {
      pending.progress(data.phase);
      return;
    }
    const run = pending;
    pending = undefined;
    clearTimeout(run.timer);
    if (data.type === 'result' && data.result.nonce === run.nonce) {
      const elapsedMs = Math.max(data.result.requestMs, Date.now() - run.startedAt);
      run.resolve({ ...data.result, elapsedMs, startupMs: elapsedMs - data.result.requestMs });
      idleTimer = setTimeout(() => closeWorker(), 75_000);
      return;
    }
    closeWorker();
    run.reject(failure(data.code ?? 'wasm-runtime', data.message ?? 'The browser client returned an unexpected response.'));
  });
  return instance;
}

function measure(nonce, progress = () => {}, startedAt = Date.now()) {
  const deadline = startedAt + testBudget;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(failure('wasm-timeout', 'The browser test ran out of time.'));
  if (pending) return Promise.reject(failure('wasm-busy', 'A browser test is already running.'));

  clearTimeout(idleTimer);
  return new Promise((resolve, reject) => {
    try {
      worker ??= startWorker();
      const timer = setTimeout(() => closeWorker(failure('wasm-timeout', 'The browser test ran out of time.')), remaining);
      pending = { resolve, reject, timer, progress, nonce, startedAt, deadline };
      worker.postMessage({ nonce, deadline });
    } catch {
      const error = failure('wasm-runtime', 'Could not start the background browser client.');
      closeWorker(error);
      reject(error);
    }
  });
}

window.addEventListener('pagehide', () => closeWorker(failure('wasm-cancelled', 'The browser test was cancelled.')));
window.AnyoneWasmLab = { measure };
