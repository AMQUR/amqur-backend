/**
 * Disposable mock parts/service — always returns unverified (no fabrication).
 */
import http from 'node:http';

const port = Number(process.env.PORT || 8083);

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  // Never invent fitment/price/availability
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      verified: false,
      availabilityVerified: false,
      priceVerified: false,
      fitmentVerified: false,
      message:
        'Parts/service data unavailable from verified source in test mock',
    }),
  );
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mock-parts-service on ${port}`);
});
