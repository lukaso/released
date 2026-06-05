// Anubis-bypass relay — the Node HTTP server that runs inside the Cloudflare
// Container. It is a thin wrapper around handleRelay(); all logic lives there
// (and is unit-tested in relay.test.mjs).
//
// Config comes from the container env (set by the GitlabRelay DO in src/relay.ts):
//   RELAY_SECRET         shared secret; requests without it are rejected 403
//   RELAY_ALLOWED_HOSTS  comma-separated SSRF allowlist (the Anubis hosts)
//   PORT                 listen port (defaults to 8080, matches defaultPort)

import { createServer } from 'node:http';
import { handleRelay, parseAllowedHosts } from './relay.mjs';

const PORT = Number(process.env.PORT ?? 8080);
const expectedSecret = process.env.RELAY_SECRET;
const allowedHosts = parseAllowedHosts(process.env.RELAY_ALLOWED_HOSTS);

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    try {
      const result = await handleRelay(
        {
          method: req.method,
          headers: req.headers,
          body: chunks.length ? Buffer.concat(chunks) : null,
        },
        { expectedSecret, allowedHosts },
      );
      res.writeHead(result.status, result.headers);
      res.end(result.body);
    } catch (err) {
      res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`relay error: ${err?.message ?? 'unknown'}`);
    }
  });
  req.on('error', () => {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
  });
});

server.listen(PORT, () => {
  const hosts = [...allowedHosts].join(', ') || '(none)';
  console.log(`gitlab-relay listening on ${PORT}; allowed hosts: ${hosts}`);
});
