const upstream = 'https://mcp.xyznot.com';
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=(self)',
};

/** Same client protocol, same ownership checks; never cache or buffer a stream. */
export async function proxyAPI(request, fetcher = fetch) {
  const url = new URL(request.url);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405});
  if (request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) return new Response('Forbidden origin', {status: 403});
  if (!/^Bearer [^\s]+$/.test(request.headers.get('Authorization') || '')) return Response.json({error: {code: 'unauthorized', message: 'Please sign in.', retryable: false}}, {status: 401, headers: {'Cache-Control': 'no-store'}});
  const target = new URL(`/instant${url.pathname}${url.search}`, upstream);
  const headers = new Headers();
  for (const name of ['Authorization', 'Accept', 'Content-Type', 'X-Impo-Model-Catalog', 'X-Request-Id', 'Range', 'If-Range']) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name));
  }
  // Workers supports manual redirects; never forward credentials to a new host.
  const init = {method: request.method, headers, signal: request.signal, redirect: 'manual', ...(request.method !== 'GET' && request.method !== 'HEAD' ? {body: request.body, duplex: 'half'} : {})};
  try {
    const result = await fetcher(target, init);
    if (result.status >= 300 && result.status < 400) {
      await result.body?.cancel();
      throw new Error('The API returned an unexpected redirect');
    }
    const responseHeaders = new Headers(securityHeaders);
    for (const name of ['Content-Type', 'Content-Disposition', 'Content-Encoding', 'Content-Range', 'Accept-Ranges', 'X-Request-Id', 'Retry-After', 'X-Vercel-AI-UI-Message-Stream']) if (result.headers.has(name)) responseHeaders.set(name, result.headers.get(name));
    responseHeaders.set('Cache-Control', 'no-store');
    return new Response(result.body, {status: result.status, headers: responseHeaders});
  } catch (error) {
    console.error("web_upstream_failure", {name: error?.name, message: String(error?.message || "Unknown transport failure").slice(0, 300)});
    return Response.json({error: {code: 'upstream_unavailable', message: 'Impo is temporarily unavailable. Please try again.', retryable: true}}, {status: 502, headers: {'Cache-Control': 'no-store', ...securityHeaders}});
  }
}

export async function webApp(request, env) {
  const url = new URL(request.url);
  if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status: 405});
  if (url.pathname === '/app') return Response.redirect(`${url.origin}/app/${url.search}`, 308);
  const asset = /\.[A-Za-z0-9]{1,12}$/.test(url.pathname);
  const target = asset ? request : new Request(new URL('/app/', url), request);
  const result = await env.ASSETS.fetch(target);
  // Pages may fall back to the marketing homepage for a missing static file.
  if (asset && !/\.html?$/i.test(url.pathname) && result.headers.get('Content-Type')?.includes('text/html')) {
    await result.body?.cancel();
    return new Response('Asset not found', {status: 404, headers: {...securityHeaders, 'Cache-Control': 'no-store'}});
  }
  const headers = new Headers(result.headers);
  for (const [key, value] of Object.entries(securityHeaders)) headers.set(key, value);
  headers.set('Cache-Control', asset && /\/assets\/.*-[\w-]{8,}\./.test(url.pathname) ? 'public, max-age=31536000, immutable' : 'no-cache');
  return new Response(result.body, {status: result.status, headers});
}
