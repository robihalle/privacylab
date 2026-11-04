'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, CircleAlert, CircleCheck, Copy, Download,
  Cpu, Globe, LoaderCircle, Monitor, Play, RefreshCw, Route, ShieldCheck,
} from 'lucide-react';

const endpoint = 'https://httpbingo.org';
const rustRepo = 'https://github.com/anyone-protocol/anyone-rust';
const terms = 'https://www.anyone.io/terms';

type Result = {
  ip: string;
  nonce: string;
  elapsedMs: number;
  at: string;
  transport: string;
  target: string;
  gatewayRoundtripMs?: number;
};
type Measurement =
  | { state: 'idle' | 'running' | 'skipped' }
  | { state: 'success'; result: Result }
  | { state: 'error'; message: string };
type Path = 'direct' | 'anyone' | 'wasm';
type Gateway = 'checking' | 'configured' | 'unconfigured' | 'unreachable';

const statusLabels = {
  idle: 'Waiting',
  running: 'Measuring',
  skipped: 'Skipped',
  success: 'Measured',
  error: 'Failed',
};

function createTestId() {
  return crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
}

function errorMessage(error: unknown, path: Path) {
  if (path === 'wasm') return 'The browser client could not complete the test. Try again or use the lab server path.';
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return path === 'direct' ? 'The test endpoint did not respond in time.' : 'The Anyone request timed out. Try the comparison again.';
  }
  if (error instanceof TypeError) {
    return path === 'direct'
      ? 'Your browser could not reach httpbingo.org. Check your connection or whether an extension blocks the request.'
      : 'Your browser could not reach the lab API. Check your connection and retry.';
  }
  return error instanceof Error ? error.message : 'The request could not be completed.';
}

async function measureDirect(nonce: string): Promise<Result> {
  const url = endpoint + '/anything/' + nonce;
  const start = performance.now();
  const response = await fetch(url, {
    cache: 'no-store',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error('The test endpoint returned HTTP ' + response.status + '.');
  const data = await response.json() as { url?: string; origin?: string };
  if (data?.url !== url || typeof data.origin !== 'string' || !data.origin.trim()) {
    throw new Error('The test endpoint did not return the expected test ID and source IP.');
  }
  return {
    ip: data.origin.trim(),
    nonce,
    elapsedMs: Math.round(performance.now() - start),
    at: new Date().toISOString(),
    transport: 'browser-https',
    target: 'httpbingo.org',
  };
}

async function measureAnyone(nonce: string): Promise<Result> {
  const response = await fetch('/api/lab/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce }),
    signal: AbortSignal.timeout(50_000),
  });
  const data = await response.json().catch(() => null) as (Result & { error?: string }) | null;
  if (!response.ok) {
    throw new Error(typeof data?.error === 'string' ? data.error : 'The lab API returned HTTP ' + response.status + '.');
  }
  if (data?.nonce !== nonce || data.transport !== 'anyone-rust-socks5h' || data.target !== 'httpbingo.org' ||
    typeof data.ip !== 'string' || !data.ip.trim() || !Number.isFinite(data.elapsedMs) || data.elapsedMs < 0) {
    throw new Error('The gateway did not return a valid result for this test ID.');
  }
  return data;
}

type WasmLab = { measure(nonce: string): Promise<Result> };
let browserClient: Promise<WasmLab> | undefined;

function loadBrowserClient() {
  browserClient ??= new Promise<WasmLab>((resolve, reject) => {
    const script = document.createElement('script');
    script.type = 'module';
    script.src = '/wasm-lab/client.js';
    const finish = (client?: WasmLab) => {
      clearTimeout(timeout);
      script.remove();
      if (client) resolve(client);
      else reject(new Error('Could not load the browser client.'));
    };
    const timeout = setTimeout(finish, 15_000);
    script.onload = () => finish((window as Window & { AnyoneWasmLab?: WasmLab }).AnyoneWasmLab);
    script.onerror = () => finish();
    document.head.append(script);
  }).catch((error) => {
    browserClient = undefined;
    throw error;
  });
  return browserClient;
}

async function measure(path: Path, nonce: string): Promise<Measurement> {
  try {
    const result = path === 'wasm'
      ? await (await loadBrowserClient()).measure(nonce)
      : await (path === 'direct' ? measureDirect(nonce) : measureAnyone(nonce));
    return { state: 'success', result };
  } catch (error) {
    return { state: 'error', message: errorMessage(error, path) };
  }
}

const pathDetails = {
  direct: { Icon: Monitor, name: 'Direct', route: 'Browser to endpoint' },
  anyone: { Icon: Route, name: 'Anyone via lab server', route: 'Gateway through SOCKS' },
  wasm: { Icon: Cpu, name: 'Anyone in the browser', route: 'WebAssembly in this tab' },
};

function ResultCard({ path, measurement }: { path: Path; measurement: Measurement }) {
  const { Icon, name, route } = pathDetails[path];
  const result = measurement.state === 'success' ? measurement.result : null;
  return (
    <article className={'result-card' + (path === 'anyone' ? ' result-card-anyone' : '')}>
      <div className="result-header">
        <span className="icon-box"><Icon size={20} aria-hidden="true" /></span>
        <h3>{name}</h3>
        <span className={'badge badge-' + measurement.state}>
          {measurement.state === 'running' && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
          {statusLabels[measurement.state]}
        </span>
      </div>
      <p className="result-label">{path === 'direct' ? 'Source IP seen from your browser' : 'Source IP seen from the exit relay'}</p>
      <p className={'result-ip' + (result ? '' : ' result-ip-empty')}>{result?.ip ?? '—'}</p>
      <div className="result-foot">
        <span>{route}</span>
        {result && <strong>{result.elapsedMs.toLocaleString('en-US')} ms</strong>}
      </div>
      {measurement.state === 'error' && <p className="card-error">{measurement.message}</p>}
      {measurement.state === 'skipped' && <p className="card-note">{path === 'wasm' ? 'Include the browser path to measure it.' : 'Run the comparison to measure this path.'}</p>}
    </article>
  );
}

export default function Home() {
  const [gateway, setGateway] = useState<Gateway>('checking');
  const [statusCheck, setStatusCheck] = useState(0);
  const [direct, setDirect] = useState<Measurement>({ state: 'idle' });
  const [anyone, setAnyone] = useState<Measurement>({ state: 'idle' });
  const [wasm, setWasm] = useState<Measurement>({ state: 'idle' });
  const [wasmEnabled, setWasmEnabled] = useState(false);
  const [includeWasm, setIncludeWasm] = useState(false);
  const [running, setRunning] = useState(false);
  const [reportNotice, setReportNotice] = useState('');
  const runInProgress = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    async function checkGateway() {
      try {
        const response = await fetch('/api/lab/status', {
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8_000)]),
        });
        if (!response.ok) throw new Error('Status request failed.');
        const data = await response.json() as { configured?: boolean; wasm?: boolean };
        if (typeof data?.configured !== 'boolean') throw new Error('Unexpected status response.');
        if (!controller.signal.aborted) {
          setGateway(data.configured ? 'configured' : 'unconfigured');
          setWasmEnabled(data.wasm === true && typeof WebAssembly !== 'undefined' && window.isSecureContext);
        }
      } catch {
        if (!controller.signal.aborted) setGateway('unreachable');
      }
    }
    void checkGateway();
    return () => controller.abort();
  }, [statusCheck]);

  async function run(compare: boolean) {
    if (runInProgress.current || (compare && gateway !== 'configured')) return;
    const directId = createTestId();
    const anyoneId = compare ? createTestId() : null;
    const wasmId = compare && wasmEnabled && includeWasm ? createTestId() : null;
    runInProgress.current = true;
    setReportNotice('');
    setRunning(true);
    setDirect({ state: 'running' });
    setAnyone({ state: compare ? 'running' : 'skipped' });
    setWasm({ state: wasmId ? 'running' : 'skipped' });
    try {
      await Promise.all([
        measure('direct', directId).then(setDirect),
        anyoneId && measure('anyone', anyoneId).then(setAnyone),
        wasmId && measure('wasm', wasmId).then(setWasm),
      ]);
    } finally {
      runInProgress.current = false;
      setRunning(false);
    }
  }

  const directResult = direct.state === 'success' ? direct.result : null;
  const anyoneResult = anyone.state === 'success' ? anyone.result : null;
  const wasmResult = wasm.state === 'success' ? wasm.result : null;
  const hasResults = Boolean(directResult || anyoneResult || wasmResult);
  const hasError = [direct, anyone, wasm].some((path) => path.state === 'error');

  function report() {
    return JSON.stringify({
      lab: 'Anyone Privacy Lab',
      version: 1,
      direct: directResult,
      anyone: anyoneResult,
      wasm: wasmResult,
      errors: {
        ...(direct.state === 'error' && { direct: direct.message }),
        ...(anyone.state === 'error' && { anyone: anyone.message }),
        ...(wasm.state === 'error' && { wasm: wasm.message }),
      },
      limitations: [
        'The Anyone request uses the native Rust client on the lab server.',
        'The experimental WASM path runs in the tab. The lab bridge can see your browser IP and the first relay address.',
        'The destination reports the source IP. The lab server forwards its own result to the browser.',
        'The browser WASM timing includes client startup and directory download.',
      ],
    }, null, 2);
  }

  function download() {
    const url = URL.createObjectURL(new Blob([report()], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'anyone-privacy-test.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(report());
      setReportNotice('Report copied.');
    } catch {
      setReportNotice('Clipboard unavailable. Download the JSON report instead.');
    }
  }

  const gatewayLabels = {
    checking: 'Checking gateway configuration',
    configured: 'Gateway configured',
    unconfigured: 'Gateway not configured',
    unreachable: 'Gateway status unavailable',
  };

  return (
    <>
      <header className="topbar">
        <div className="shell topbar-inner">
          <Link className="brand" href="/" aria-label="Anyone Privacy Lab home">
            <Image src="/anyone-logo-white.png" alt="" width={106} height={28} unoptimized priority />
            <span>Privacy Lab</span>
          </Link>
          <nav aria-label="Main navigation">
            <a href="#test">Run a test</a>
            <a href="#method">How it works</a>
          </nav>
        </div>
      </header>

      <main className="shell">
        <section className="intro" aria-labelledby="title">
          <div className="eyebrow"><ShieldCheck size={16} aria-hidden="true" /> Independent community demo</div>
          <h1 id="title">Anyone Privacy Lab</h1>
          <p>See which IP address a website receives from your browser and which one it receives through the Anyone network.</p>
        </section>

        <section className="panel test-panel" id="test" aria-labelledby="test-title">
          <div className="section-heading">
            <div>
              <h2 id="test-title">Compare your connection</h2>
              <p>Each selected path sends its own HTTPS request to <a href={endpoint} target="_blank" rel="noreferrer">httpbingo.org <ArrowUpRight size={13} aria-hidden="true" /></a>.</p>
            </div>
            <div className="gateway-status">
              <span className={'badge gateway-' + gateway} role="status"><i />{gatewayLabels[gateway]}</span>
              {(gateway === 'unconfigured' || gateway === 'unreachable') && (
                <button className="icon-button" type="button" aria-label="Recheck gateway status" title="Recheck gateway status" onClick={() => {
                  setGateway('checking');
                  setStatusCheck((value) => value + 1);
                }}><RefreshCw size={16} aria-hidden="true" /></button>
              )}
            </div>
          </div>

          <div className="actions">
            <button className="button primary" type="button" disabled={running || gateway !== 'configured'} onClick={() => void run(true)}>
              {running && anyone.state !== 'skipped' ? <LoaderCircle size={17} className="spin" aria-hidden="true" /> : <Play size={17} aria-hidden="true" />}
              {running && anyone.state !== 'skipped' ? 'Comparing paths…' : wasmEnabled && includeWasm ? 'Compare all three paths' : 'Compare live paths'}
            </button>
            <button className="button secondary" type="button" disabled={running} onClick={() => void run(false)}>
              {running && anyone.state === 'skipped' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              Direct test only
            </button>
          </div>
          {wasmEnabled && (
            <div className="wasm-option">
              <label>
                <input type="checkbox" checked={includeWasm} disabled={running || gateway !== 'configured'}
                  onChange={(event) => setIncludeWasm(event.target.checked)} aria-describedby="wasm-consent" />
                Include the experimental browser path
              </label>
              <p id="wasm-consent">Selecting this option and starting the test means you accept the <a href={terms} target="_blank" rel="noreferrer">Anyone terms</a>.</p>
            </div>
          )}
          <p className="action-note">The direct test shares your public IP with httpbingo.org. Each request has a separate random ID, and the results are paired in this tab.</p>

          <div className="result-grid" aria-live="polite">
            <ResultCard path="direct" measurement={direct} />
            <ResultCard path="anyone" measurement={anyone} />
            {wasmEnabled ? <ResultCard path="wasm" measurement={wasm} /> : (
              <article className="result-card result-card-planned">
                <div className="result-header">
                  <span className="icon-box"><Cpu size={20} aria-hidden="true" /></span>
                  <h3>Anyone in the browser</h3>
                  <span className="badge">Unavailable</span>
                </div>
                <p className="result-label">The experimental WebAssembly path is unavailable in this session.</p>
                <a className="planned-link" href="#wasm-method">See how it works <ArrowRight size={15} aria-hidden="true" /></a>
              </article>
            )}
          </div>

          {!running && directResult && anyoneResult && (
            <p className="comparison" role="status">
              <CircleCheck size={19} aria-hidden="true" />
              {wasmResult
                ? (directResult.ip === wasmResult.ip ? 'The direct and browser WASM tests returned the same source IP.' : 'The browser WASM test returned a different source IP from the direct request.')
                : (directResult.ip === anyoneResult.ip ? 'The endpoint saw the same source IP on both paths.' : 'The endpoint saw different source IPs on the two paths.')}
            </p>
          )}
          {!running && hasError && (
            <p className="comparison comparison-warning" role="status">
              <CircleAlert size={19} aria-hidden="true" />
              {hasResults ? 'Some measurements completed. See the cards for details.' : 'The test could not be completed. See the cards for details.'}
            </p>
          )}

          <div className="report-row">
            <p>{hasResults ? 'Each measurement includes its own test ID in the report.' : 'Results can be exported after a measurement.'}</p>
            <div className="report-actions">
              <button type="button" className="button quiet" disabled={!hasResults || running} onClick={() => void copy()}><Copy size={16} aria-hidden="true" /> Copy</button>
              <button type="button" className="button quiet" disabled={!hasResults || running} onClick={download}><Download size={16} aria-hidden="true" /> JSON</button>
            </div>
          </div>
          {reportNotice && <p className="report-notice" role="status">{reportNotice}</p>}
        </section>

        <section className="method" id="method" aria-labelledby="method-title">
          <div className="section-heading">
            <div>
              <div className="eyebrow">Test method</div>
              <h2 id="method-title">Where each request goes</h2>
              <p>httpbingo.org echoes the source IP and test URL. Each response must match the ID sent for that path.</p>
            </div>
          </div>

          <div className="method-grid">
            <article className="panel method-card">
              <div className="method-heading"><span className="icon-box"><Monitor size={20} aria-hidden="true" /></span><h3>Direct request</h3></div>
              <div className="path" aria-label="Your browser to httpbingo.org">
                <span>Your browser</span><ArrowRight size={16} aria-hidden="true" /><span><Globe size={15} aria-hidden="true" /> httpbingo.org</span>
              </div>
              <p>Your browser connects directly to the test endpoint. It sees the public IP of your current connection, which may be a VPN exit IP. The lab serves this page but does not receive the direct test request.</p>
            </article>
            <article className="panel method-card">
              <div className="method-heading"><span className="icon-box"><Route size={20} aria-hidden="true" /></span><h3>Anyone via lab server</h3></div>
              <div className="path" aria-label="Your browser to the lab server, then through an Anyone exit relay to httpbingo.org">
                <span>Your browser</span><ArrowRight size={16} aria-hidden="true" /><span>Lab server</span><ArrowRight size={16} aria-hidden="true" /><span>Anyone exit</span><ArrowRight size={16} aria-hidden="true" /><span><Globe size={15} aria-hidden="true" /> httpbingo.org</span>
              </div>
              <p>The lab receives your browser connection and the ID for this path. Its native Anyone Rust client makes the HTTPS request. The endpoint sees the exit relay’s IP.</p>
            </article>
            <article className="panel method-card method-card-planned" id="wasm-method">
              <div className="method-heading"><span className="icon-box"><Cpu size={20} aria-hidden="true" /></span><h3>Anyone in the browser</h3><span className="badge">Experimental</span></div>
              <div className="path" aria-label="WASM client in your tab through the lab bridge and an Anyone exit to httpbingo.org">
                <span>WASM in your tab</span><ArrowRight size={16} aria-hidden="true" /><span>Lab bridge</span><ArrowRight size={16} aria-hidden="true" /><span>Anyone exit</span><ArrowRight size={16} aria-hidden="true" /><span><Globe size={15} aria-hidden="true" /> httpbingo.org</span>
              </div>
              <p>WebAssembly verifies the signed Anyone directory and builds the circuit in your tab. The lab bridge forwards encrypted traffic to the first relay. It can see your incoming IP and the first relay address. The endpoint sees the exit relay’s IP.</p>
            </article>
          </div>

          <div className="notes">
            <details>
              <summary>What does the result show?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>The measurements apply to the requests made by this test. The result cards show which path made each request. Your other browser traffic continues to use its usual connection.</p>
            </details>
            <details>
              <summary>How should I read the timings?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>Direct measures the browser request. The lab server measures its own request through SOCKS. The browser WASM measurement includes directory download, client startup, circuit setup, and the HTTPS request.</p>
            </details>
            <details>
              <summary>What data is shared?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>The destination sees each request’s own test ID, source IP and standard HTTP metadata. Each path uses a separate test ID. Other signals, such as timing, can still make requests linkable. Hosting and test infrastructure may keep operational logs.</p>
            </details>
          </div>
        </section>

        <footer className="footer">
          <span>Anyone Privacy Lab · Independent community demo by Robert</span>
          <a href={rustRepo} target="_blank" rel="noreferrer">Anyone Rust client <ArrowUpRight size={15} aria-hidden="true" /></a>
        </footer>
      </main>
    </>
  );
}
