import puppeteer from 'puppeteer-core';
const b = await puppeteer.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'], userDataDir: '/tmp/survivor-test-profile' });
await b.defaultBrowserContext().overridePermissions('http://127.0.0.1:3910', ['notifications']);
const p = await b.newPage(); await p.goto('http://127.0.0.1:3910/', { waitUntil: 'networkidle0' });
const r = await p.evaluate(async () => { const st = await (await fetch('/api/state')).json(); const key = st.vapidPublicKey; const pad = '='.repeat((4 - key.length % 4) % 4); const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/')); const k = Uint8Array.from(raw, (c) => c.charCodeAt(0));
  const reg = await navigator.serviceWorker.ready; const perm = Notification.permission; try { const sub = await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: k }), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 8s')), 8000))]); const res = await (await fetch('/api/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(sub.toJSON()) })).json(); return { perm, endpoint: sub.endpoint.slice(0, 40), res }; } catch (e) { return { perm, err: e.message }; } });
console.log(r);
if (!r.err) { const t = await (await fetch('http://127.0.0.1:3910/api/test-push', { method: 'POST' })).json(); console.log('test-push', t); }
await b.close();
