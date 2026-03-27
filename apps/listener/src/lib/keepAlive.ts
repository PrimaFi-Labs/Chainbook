// apps/listener/src/lib/keepAlive.ts
//
// Starts a tiny HTTP server on PORT (default 10000, which Render expects).
// Responds to GET /health with a 200 so external monitors (UptimeRobot etc.)
// can ping it every 5 minutes and prevent Render from spinning down the service.
//
// Usage: call startKeepAliveServer() once at the top of main().


import * as http from 'http'

const PORT = Number(process.env.PORT ?? 10_000)

export function startKeepAliveServer(): void {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('OK')
      return
    }
    // Everything else gets a 404 — no accidental data exposure
    res.writeHead(404)
    res.end()
  })

  server.listen(PORT, () => {
    console.log(`[KeepAlive] Health server listening on port ${PORT}`)
  })

  server.on('error', (err) => {
    // Non-fatal — listener keeps running even if the health port is unavailable
    console.error('[KeepAlive] Health server error:', err.message)
  })
}