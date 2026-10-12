'use strict';

// Just enough of ntfy's HTTP API for the tests: publish, poll and stream.

const http = require('http');

function start() {
  const topics = new Map();
  const subscribers = new Set();
  let seq = 0;

  const after = (since) => (m) => since === 'all' || (/^\d+$/.test(since) ? m.time >= Number(since) : true);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const m = { id: `m${++seq}`, time: Math.floor(Date.now() / 1000), event: 'message', topic: parts[0], message: body };
        if (!topics.has(m.topic)) topics.set(m.topic, []);
        topics.get(m.topic).push(m);
        for (const s of subscribers) if (s.topics.includes(m.topic)) s.res.write(`${JSON.stringify(m)}\n`);
        res.end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
      const wanted = parts[0].split(',');
      const since = url.searchParams.get('since');
      const backlog = since ? wanted.flatMap((t) => topics.get(t) || []).filter(after(since)) : [];
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (url.searchParams.get('poll')) {
        res.end(backlog.map((m) => `${JSON.stringify(m)}\n`).join(''));
        return;
      }
      res.write(`${JSON.stringify({ event: 'open', topic: parts[0] })}\n`);
      for (const m of backlog) res.write(`${JSON.stringify(m)}\n`);
      const sub = { topics: wanted, res };
      subscribers.add(sub);
      req.on('close', () => subscribers.delete(sub));
      return;
    }
    res.writeHead(404);
    res.end('{}');
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      topics,
      close: () => { for (const s of subscribers) s.res.destroy(); server.close(); },
    }));
  });
}

module.exports = { start };
