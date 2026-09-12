import puppeteer from 'puppeteer-core';
const ok = (label, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`); if (!cond) process.exitCode = 1; };
const BASE = process.env.BASE || 'http://127.0.0.1:3910';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'], userDataDir: '/tmp/survivor-test-profile' });
await b.defaultBrowserContext().overridePermissions(BASE, ['notifications']);
const p = await b.newPage(); await p.goto(BASE + '/', { waitUntil: 'networkidle0' });
const r = await p.evaluate(async () => { const st = await (await fetch('/api/state')).json(); const key = st.vapidPublicKey; const pad = '='.repeat((4 - key.length % 4) % 4); const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')); const k = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const reg = await navigator.serviceWorker.ready; const perm = Notification.permission; try { const sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000))]); const res = await (await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })).json(); return { perm, endpoint: sub.endpoint.slice(0, 40), res }; } catch (e) { return { perm, err: e.message }; } });
console.log(r);
ok('push subscription succeeds (no error)', !r.err);
if (!r.err) {
  ok('subscribe endpoint returns a device count', typeof r.res?.count === 'number' && r.res.count >= 1);
  const t = await (await fetch(BASE + '/api/test-push', { method: 'POST' })).json();
  console.log('test-push', t);
  ok('server delivers a test push to the subscription', t.sent >= 1);
} else {
  // A push service is not always reachable from CI; surface it but don't hard-fail the whole suite on
  // an environmental limitation — the subscribe/round-trip path above is what this test owns.
  console.log('push service unavailable in this environment:', r.err);
}
await b.close();
console.log(process.exitCode ? 'FAILURES' : 'all checks passed');
