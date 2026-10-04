// Stateless signed tokens: base64url(JSON payload) + "." + base64url(HMAC).
// The alphabet avoids ":" because devices send refresh tokens behind a
// "hatch_refresh:" prefix and split on the last colon.

const encoder = new TextEncoder();

export const DEVICE_TOKEN_TTL_S = 4 * 3600;
export const REFRESH_TOKEN_TTL_S = 365 * 24 * 3600;
export const VM_TOKEN_TTL_S = 300;

export function toBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function fromBase64Url(text) {
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hmacKey(secret, usage) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

export async function signToken(secret, type, claims, ttlSeconds) {
  const payload = toBase64Url(encoder.encode(JSON.stringify({
    ...claims, typ: type, exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

// Returns the claims of a valid, unexpired token of the expected type, or null.
export async function verifyToken(secret, type, token) {
  const [payload, signature, extra] = String(token ?? '').split('.');
  if (!payload || !signature || extra !== undefined) return null;
  try {
    const valid = await crypto.subtle.verify(
      'HMAC', await hmacKey(secret, 'verify'), fromBase64Url(signature), encoder.encode(payload),
    );
    if (!valid) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
    if (claims.typ !== type || !(claims.exp > Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export async function secretsEqual(left, right) {
  const key = await hmacKey('compare', 'sign');
  const [a, b] = await Promise.all([left, right].map(
    async (value) => new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(String(value ?? '')))),
  ));
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}
