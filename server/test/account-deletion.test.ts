import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { AppleGrantRevoker, parseAppleSignInConfig } from '../src/accounts/apple.js';
import { parseConfirmation } from '../src/accounts/contract.js';
const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const config = { teamId: 'BN3369Y53F', keyId: '3G56YV7P7K', nativeClientId: 'ai.impo', webClientId: 'ai.impo.signin', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const identity = (sub: string) => 'header.' + Buffer.from(JSON.stringify({ sub, aud: 'ai.impo', iss: 'https://appleid.apple.com', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url') + '.signature';

test('Apple native exchange verifies the linked subject and revokes the server-issued refresh token', async () => {
  const calls: string[] = [];
  const revoker = new AppleGrantRevoker(parseAppleSignInConfig(JSON.stringify(config)), (async (url: URL | string | Request, init: RequestInit) => {
    const form = init.body as URLSearchParams; calls.push(String(url));
    assert.equal(form.get('client_id'), 'ai.impo');
    const [header, payload, signature] = form.get('client_secret')!.split('.');
    assert.ok(verify('sha256', Buffer.from(`${header}.${payload}`), { key: keys.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature!, 'base64url')));
    if (String(url).endsWith('/token')) {
      assert.equal(form.get('code'), 'one-time-native-code');
      return Response.json({ id_token: identity('apple-user'), refresh_token: 'private-refresh-token' });
    }
    assert.equal(form.get('token'), 'private-refresh-token'); assert.equal(form.get('token_type_hint'), 'refresh_token');
    return new Response(null, { status: 200 });
  }) as typeof fetch);
  await revoker.revokeCode('one-time-native-code', 'apple-user');
  assert.deepEqual(calls.map(s => new URL(s).pathname), ['/auth/token', '/auth/revoke']);
});
test('a different Apple account cannot revoke the grant or confirm deletion', async () => {
  let calls = 0;
  const revoker = new AppleGrantRevoker(config, (async () => { calls++; return Response.json({ id_token: identity('someone-else'), refresh_token: 'token' }); }) as typeof fetch);
  await assert.rejects(revoker.revokeCode('code', 'owner'), { code: 'apple_account_mismatch' }); assert.equal(calls, 1);
});
test('Apple upstream failures expose no token or provider body', async () => {
  const revoker = new AppleGrantRevoker(config, (async () => new Response('secret-debug-body', { status: 503 })) as typeof fetch);
  await assert.rejects(revoker.revokeToken('private'), { message: 'Apple authorization could not be revoked' });
  assert.throws(() => parseConfirmation({ challengeId: 'x', token: 'y', confirmation: 'DELETE' }));
});
