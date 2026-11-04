'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowDown, ArrowRight, ArrowUpRight, CircleAlert, CircleCheck, Copy, Download,
  Globe, LoaderCircle, Monitor, Play, RefreshCw, Route, ShieldCheck,
} from 'lucide-react';

const endpoint = 'https://httpbingo.org';
const rustRepo = 'https://github.com/anyone-protocol/anyone-rust';

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
type Gateway = 'checking' | 'configured' | 'unconfigured' | 'unreachable';

const statusLabels = {
  idle: 'Waiting',
  running: 'Measuring',
  skipped: 'Skipped',
  success: 'Measured',
  error: 'Failed',
};

function errorMessage(error: unknown, path: 'direct' | 'anyone') {
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

async function measure(path: 'direct' | 'anyone', nonce: string): Promise<Measurement> {
  try {
    const result = await (path === 'direct' ? measureDirect(nonce) : measureAnyone(nonce));
    return { state: 'success', result };
  } catch (error) {
    return { state: 'error', message: errorMessage(error, path) };
  }
}

function ResultCard({ anyone = false, measurement }: { anyone?: boolean; measurement: Measurement }) {
  const Icon = anyone ? Route : Monitor;
  const result = measurement.state === 'success' ? measurement.result : null;
  return (
    <article className={'result-card' + (anyone ? ' result-card-anyone' : '')}>
      <div className="result-header">
        <span className="icon-box"><Icon size={20} aria-hidden="true" /></span>
        <h3>{anyone ? 'Via Anyone' : 'Direct'}</h3>
        <span className={'badge badge-' + measurement.state}>
          {measurement.state === 'running' && <LoaderCircle size={13} className="spin" aria-hidden="true" />}
          {statusLabels[measurement.state]}
        </span>
      </div>
      <p className="result-label">{anyone ? 'Source IP seen from the exit relay' : 'Source IP seen from your browser'}</p>
      <p className={'result-ip' + (result ? '' : ' result-ip-empty')}>{result?.ip ?? '—'}</p>
      <div className="result-foot">
        <span>{anyone ? 'Gateway through SOCKS' : 'Browser to endpoint'}</span>
        {result && <strong>{result.elapsedMs.toLocaleString('en-US')} ms</strong>}
      </div>
      {measurement.state === 'error' && <p className="card-error">{measurement.message}</p>}
      {measurement.state === 'skipped' && <p className="card-note">Run the comparison to measure this path.</p>}
    </article>
  );
}

export default function Home() {
  const [gateway, setGateway] = useState<Gateway>('checking');
  const [statusCheck, setStatusCheck] = useState(0);
  const [direct, setDirect] = useState<Measurement>({ state: 'idle' });
  const [anyone, setAnyone] = useState<Measurement>({ state: 'idle' });
  const [running, setRunning] = useState(false);
  const [testId, setTestId] = useState<string>();
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
        const data = await response.json() as { configured?: boolean };
        if (typeof data?.configured !== 'boolean') throw new Error('Unexpected status response.');
        if (!controller.signal.aborted) setGateway(data.configured ? 'configured' : 'unconfigured');
      } catch {
        if (!controller.signal.aborted) setGateway('unreachable');
      }
    }
    void checkGateway();
    return () => controller.abort();
  }, [statusCheck]);

  async function run(compare: boolean) {
    if (runInProgress.current || (compare && gateway !== 'configured')) return;
    runInProgress.current = true;
    const nonce = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, '0')).join('').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, '$1-$2-$3-$4-$5');
    setTestId(nonce);
    setReportNotice('');
    setRunning(true);
    setDirect({ state: 'running' });
    setAnyone({ state: compare ? 'running' : 'skipped' });
    try {
      await Promise.all([
        measure('direct', nonce).then(setDirect),
        compare && measure('anyone', nonce).then(setAnyone),
      ]);
    } finally {
      runInProgress.current = false;
      setRunning(false);
    }
  }

  const directResult = direct.state === 'success' ? direct.result : null;
  const anyoneResult = anyone.state === 'success' ? anyone.result : null;
  const hasResults = Boolean(directResult || anyoneResult);
  const hasError = direct.state === 'error' || anyone.state === 'error';

  function report() {
    return JSON.stringify({
      lab: 'Anyone Privacy Lab',
      version: 1,
      direct: directResult,
      anyone: anyoneResult,
      errors: {
        ...(direct.state === 'error' && { direct: direct.message }),
        ...(anyone.state === 'error' && { anyone: anyone.message }),
      },
      limitations: [
        'The Anyone request uses the native Rust client on the lab server.',
        'The exit IP is reported by the gateway. The circuit is not independently verified.',
        'Timings begin at the browser for Direct and at the gateway for Anyone.',
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
              <p>Both requests use HTTPS and the same test ID at <a href={endpoint} target="_blank" rel="noreferrer">httpbingo.org <ArrowUpRight size={13} aria-hidden="true" /></a>.</p>
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
              {running && anyone.state !== 'skipped' ? 'Comparing paths…' : 'Compare both paths'}
            </button>
            <button className="button secondary" type="button" disabled={running} onClick={() => void run(false)}>
              {running && anyone.state === 'skipped' && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
              Direct test only
            </button>
          </div>
          <p className="action-note">The direct test shares your current public IP and a random test ID with httpbingo.org.</p>

          <div className="result-grid" aria-live="polite">
            <ResultCard measurement={direct} />
            <ResultCard anyone measurement={anyone} />
          </div>

          {!running && directResult && anyoneResult && (
            <p className="comparison" role="status">
              <CircleCheck size={19} aria-hidden="true" />
              {directResult.ip === anyoneResult.ip ? 'The endpoint saw the same source IP on both paths.' : 'The endpoint saw different source IPs on the two paths.'}
            </p>
          )}
          {!running && hasError && (
            <p className="comparison comparison-warning" role="status">
              <CircleAlert size={19} aria-hidden="true" />
              {hasResults ? 'One path completed. See the other card for the error.' : 'The test could not be completed. See the cards for details.'}
            </p>
          )}

          <div className="report-row">
            <p>{testId ? <>Test ID <code>{testId}</code></> : 'Results appear here after you run a test.'}</p>
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
              <p>httpbingo.org echoes the source IP and test URL. The lab checks that the test ID matches before displaying a result.</p>
            </div>
          </div>

          <div className="method-grid">
            <article className="panel method-card">
              <div className="method-heading"><span className="icon-box"><Monitor size={20} aria-hidden="true" /></span><h3>Direct request</h3></div>
              <div className="path" aria-label="Your browser to httpbingo.org">
                <span>Your browser</span><ArrowRight size={16} aria-hidden="true" /><span><Globe size={15} aria-hidden="true" /> httpbingo.org</span>
              </div>
              <p>Your browser connects directly to the test endpoint. It sees the public IP of your current connection, which may be a VPN exit IP.</p>
            </article>
            <article className="panel method-card">
              <div className="method-heading"><span className="icon-box"><Route size={20} aria-hidden="true" /></span><h3>Anyone request</h3></div>
              <div className="path" aria-label="Your browser to the lab server, then through an Anyone exit relay to httpbingo.org">
                <span>Your browser</span><ArrowRight size={16} aria-hidden="true" /><span>Lab server</span><ArrowRight size={16} aria-hidden="true" /><span>Anyone exit</span><ArrowRight size={16} aria-hidden="true" /><span><Globe size={15} aria-hidden="true" /> httpbingo.org</span>
              </div>
              <p>Your browser sends the test ID to this lab. The lab’s native Anyone Rust client makes the HTTPS request through the Anyone network. The endpoint sees the exit relay’s IP.</p>
            </article>
          </div>

          <div className="notes">
            <details>
              <summary>What does the result show?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>The comparison applies to these two requests. The Anyone result comes from the lab gateway, and the diagram shows the route in general terms. Your other browser traffic continues to use its usual connection.</p>
            </details>
            <details>
              <summary>How should I read the timings?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>Direct measures the browser request. Anyone measures the gateway’s request through SOCKS. They start in different places, so the numbers describe the individual paths.</p>
            </details>
            <details>
              <summary>What data is shared?<ArrowDown size={16} aria-hidden="true" /></summary>
              <p>The destination sees the test ID, source IP and standard HTTP metadata. The lab processes the ID for the Anyone request. Hosting and test infrastructure may keep operational logs. Results are displayed in this tab and can be exported as JSON.</p>
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
