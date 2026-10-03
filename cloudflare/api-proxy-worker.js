// Cloudflare Worker: exposes the Hermes account service at
// https://www.oversight.ee/api/* by proxying to the private tunnel
// hostname (no open ports on the VPS, TLS is the tunnel edge cert).
// Dashboard: Workers > Create > paste this > route www.oversight.ee/api/*
// Release gate: npm run release:scan stays red until AUTH_BASE_URL points
// at https://www.oversight.ee/api and this route is live.
const ORIGIN = 'https://auth.oversight.ee';

export default {
  async fetch(req) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) {
      return new Response('Not found', { status: 404 });
    }
    // Forward the full path: the account service routes carry the /api
    // prefix itself (e.g. /api/auth/login), the Worker only gates on it.
    // Exception: /health lives at the origin root, so /api/health maps
    // to /health for a consistent public surface.
    const path = url.pathname === '/api/health' ? '/health' : url.pathname;
    const target = ORIGIN + path + url.search;
    const headers = new Headers(req.headers);
    headers.set('host', new URL(ORIGIN).host);
    headers.set('x-forwarded-proto', 'https');
    return fetch(target, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      redirect: 'manual',
    });
  },
};
