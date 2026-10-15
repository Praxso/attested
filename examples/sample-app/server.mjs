import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 4173);
const broken = process.env.ATTESTED_SAMPLE_BREAK === '1';
const sha = process.env.GITHUB_SHA ?? 'dev';

createServer((req, res) => {
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sha }));
    return;
  }
  if (req.url.startsWith('/api/greeting')) {
    res.writeHead(broken ? 500 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(broken ? { error: 'greeting service unavailable' } : { greeting: 'Hello from sampel-app' }));
    return;
  }
  // Broken mode also logs a console error and makes a failing request whose query and email must be redacted in the packet.
  const script = broken
    ? `<script>console.error('greeting service failed for ops@example.com with token=sample-not-a-secret');
fetch('/api/greeting?key=sample-not-a-secret#frag');</script>`
    : '';
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>sample-app</title></head>
<body><h1>${broken ? 'Something broke' : 'Hello from sampel-app'}</h1>
<p>Build <code>${sha}</code></p>${script}</body></html>`);
}).listen(port, () => console.log(`sample-app listening on http://localhost:${port}`));
