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
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html><head><title>sample-app</title></head>
<body><h1>${broken ? 'Something broke' : 'Hello from sample-app'}</h1>
<p>Build <code>${sha}</code></p></body></html>`);
}).listen(port, () => console.log(`sample-app listening on http://localhost:${port}`));
