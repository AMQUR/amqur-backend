/**
 * Disposable mock CRM webhook receiver for local tests.
 * Modes via FAIL_MODE env: none | 500 | timeout | reject
 */
import http from 'node:http';

const port = Number(process.env.PORT || 8081);
const failMode = process.env.FAIL_MODE || 'none';
const events = [];

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, failMode, received: events.length }));
    return;
  }
  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ events }));
    return;
  }
  if (req.method === 'DELETE' && req.url === '/events') {
    events.length = 0;
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === 'POST') {
    if (failMode === 'timeout') {
      // hang until client timeout
      return;
    }
    if (failMode === '500') {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'mock_crm_500' }));
      return;
    }
    if (failMode === 'reject') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'mock_crm_reject' }));
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      body = { raw: true };
    }
    events.push({ at: new Date().toISOString(), body });
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, accepted: true, id: `mock-${events.length}` }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock-crm listening on ${port} failMode=${failMode}`);
});
