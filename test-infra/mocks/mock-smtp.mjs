/**
 * Disposable mock SMTP server + HTTP inspection API for local tests. Never relays anything:
 * accepted messages are only kept in memory.
 *
 *   SMTP  : SMTP_PORT (default 1025)   EHLO/HELO, MAIL FROM, RCPT TO, DATA, RSET, NOOP, QUIT
 *   HTTP  : HTTP_PORT (default 8085)
 *     GET    /health
 *     GET    /messages            -> { messages: [{ id, from, to[], raw, at }] }
 *     DELETE /messages
 *     POST   /mode                -> body { mode, count? }
 *        mode: none | tempfail (451 after DATA) | reject (550 on RCPT) | drop (close after DATA)
 *        count: fail only the next N messages, then behave normally (default: until changed)
 */
import http from 'node:http';
import net from 'node:net';

const smtpPort = Number(process.env.SMTP_PORT || 1025);
const httpPort = Number(process.env.HTTP_PORT || 8085);
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MODES = ['none', 'tempfail', 'reject', 'drop'];

let mode = MODES.includes(process.env.FAIL_MODE) ? process.env.FAIL_MODE : 'none';
let failRemaining = Infinity;
const messages = [];

function currentMode() {
  if (mode === 'none') return 'none';
  if (failRemaining <= 0) {
    mode = 'none';
    return 'none';
  }
  return mode;
}
function consumeFailure() {
  if (failRemaining !== Infinity) failRemaining -= 1;
}

const smtp = net.createServer((socket) => {
  socket.setEncoding('utf8');
  socket.setTimeout(15_000, () => socket.destroy());
  let buffer = '';
  let inData = false;
  let from = null;
  let to = [];
  let data = '';
  const reply = (line) => socket.write(`${line}\r\n`);
  const reset = () => {
    from = null;
    to = [];
    data = '';
    inData = false;
  };
  reply('220 mock-smtp ESMTP ready');

  const onCommand = (line) => {
    const upper = line.toUpperCase();
    if (upper.startsWith('EHLO')) {
      socket.write('250-mock-smtp\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 SIZE 1048576\r\n');
    } else if (upper.startsWith('HELO')) {
      reply('250 mock-smtp');
    } else if (upper.startsWith('MAIL FROM:')) {
      reset();
      from = (line.slice(10).match(/<([^>]*)>/) || [])[1] ?? '';
      reply('250 2.1.0 OK');
    } else if (upper.startsWith('RCPT TO:')) {
      if (from === null) return reply('503 5.5.1 MAIL first');
      if (currentMode() === 'reject') {
        consumeFailure();
        return reply('550 5.1.1 mailbox unavailable');
      }
      to.push((line.slice(8).match(/<([^>]*)>/) || [])[1] ?? '');
      reply('250 2.1.5 OK');
    } else if (upper === 'DATA') {
      if (from === null || to.length === 0) return reply('503 5.5.1 RCPT first');
      inData = true;
      reply('354 End data with <CR><LF>.<CR><LF>');
    } else if (upper === 'RSET') {
      reset();
      reply('250 2.0.0 OK');
    } else if (upper === 'NOOP') {
      reply('250 2.0.0 OK');
    } else if (upper === 'QUIT') {
      reply('221 2.0.0 Bye');
      socket.end();
    } else {
      reply('502 5.5.2 Command not implemented');
    }
  };

  const onMessage = () => {
    const m = currentMode();
    if (m === 'tempfail') {
      consumeFailure();
      reset();
      return reply('451 4.3.0 mock temporary failure');
    }
    if (m === 'drop') {
      consumeFailure();
      return socket.destroy();
    }
    const id = `mock-${messages.length + 1}`;
    // Undo SMTP dot-stuffing.
    const raw = data.replace(/(^|\r\n)\.\./g, '$1.');
    messages.push({ id, from, to, raw, at: new Date().toISOString() });
    reset();
    reply(`250 2.0.0 OK queued as ${id}`);
  };

  socket.on('data', (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_MESSAGE_BYTES * 2) return socket.destroy();
    for (;;) {
      if (inData) {
        const end = buffer.startsWith('.\r\n') ? 0 : buffer.indexOf('\r\n.\r\n');
        if (end < 0) break;
        data = end === 0 ? '' : buffer.slice(0, end + 2);
        buffer = buffer.slice(end === 0 ? 3 : end + 5);
        inData = false;
        onMessage();
      } else {
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        onCommand(line);
      }
    }
  });
  socket.on('error', () => {});
});

const api = http.createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/health')
    return json(200, { ok: true, mode: currentMode(), received: messages.length });
  if (req.method === 'GET' && req.url === '/messages') return json(200, { messages });
  if (req.method === 'DELETE' && req.url === '/messages') {
    messages.length = 0;
    res.writeHead(204);
    return res.end();
  }
  if (req.method === 'POST' && req.url === '/mode') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      return json(400, { ok: false, error: 'bad_json' });
    }
    if (!MODES.includes(body.mode)) return json(400, { ok: false, error: 'bad_mode' });
    mode = body.mode;
    failRemaining =
      Number.isInteger(body.count) && body.count > 0 ? body.count : Infinity;
    return json(200, { ok: true, mode, count: Number.isFinite(failRemaining) ? failRemaining : null });
  }
  res.writeHead(404);
  res.end();
});

smtp.listen(smtpPort, '0.0.0.0', () => {
  console.log(`mock-smtp listening smtp=${smtpPort} failMode=${mode}`);
});
api.listen(httpPort, '0.0.0.0', () => {
  console.log(`mock-smtp inspection api on ${httpPort}`);
});
