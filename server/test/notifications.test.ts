import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import { test } from 'node:test';
import { FCMSender, fcmMessage, parseFCMCredentials, type PushMessage } from '../src/notifications/fcm.js';
import { registrationInput, settingsInput } from '../src/notifications/contract.js';
const input: PushMessage = { platform: 'ios', token: 'synthetic-test-token', registrationId: randomUUID(), eventId: randomUUID(), category: 'chat', targetId: randomUUID(), failed: false, expiresAt: new Date(Date.now() + 3600_000) };
test('FCM uses generic APNs alerts and Android data messages with the shared routing contract', () => {
  const apple = fcmMessage(input);
  assert.ok('apns' in apple);
  assert.equal(apple.apns?.headers['apns-push-type'], 'alert');
  assert.equal(apple.apns?.headers['apns-collapse-id'], input.eventId);
  assert.equal(apple.data.registrationId, input.registrationId);
  assert.equal(apple.data.version, '1');
  const android = fcmMessage({ ...input, platform: 'android' });
  assert.ok('android' in android);
  assert.equal(android.android?.priority, 'high');
  assert.equal('notification' in android, false);
  assert.equal('apns' in android, false);
  for (const category of ['chat', 'tasks', 'brief'] as const) {
    for (const failed of [false, true]) {
      const apple = fcmMessage({ ...input, category, failed });
      const android = fcmMessage({ ...input, category, failed, platform: 'android' });
      assert.ok('apns' in apple);
      assert.deepEqual(apple.apns?.payload.aps.alert, { title: android.data.title, body: android.data.body });
      assert.doesNotMatch(`${android.data.title} ${android.data.body}`, /impo|needs attention|has an update/i);
      if (category === 'brief') assert.equal(android.data.title, 'You have a brief');
      else if (failed) assert.match(android.data.title, /couldn't/i);
    }
  }
});
test('FCM signs a scoped JWT, reuses OAuth, distinguishes token invalidation and throttling', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentials = parseFCMCredentials(JSON.stringify({ type: 'service_account', project_id: 'impo-unit-test', client_email: 'sender@impo-unit-test.iam.gserviceaccount.com', private_key_id: 'test', private_key: privateKey.export({ format: 'pem', type: 'pkcs8' }), token_uri: 'https://oauth2.googleapis.com/token' }));
  let authCalls = 0; let sends = 0;
  const sender = new FCMSender(credentials, async (url, request) => {
    if (String(url).includes('oauth2')) {
      authCalls++; const jwt = (request!.body as URLSearchParams).get('assertion')!.split('.');
      assert.equal(verify('RSA-SHA256', Buffer.from(jwt.slice(0, 2).join('.')), publicKey, Buffer.from(jwt[2]!, 'base64url')), true);
      assert.equal(JSON.parse(Buffer.from(jwt[1]!, 'base64url').toString()).scope, 'https://www.googleapis.com/auth/firebase.messaging');
      return Response.json({ access_token: 'synthetic-oauth', expires_in: 3600 });
    }
    sends++; assert.equal(new Headers(request!.headers).get('Authorization'), 'Bearer synthetic-oauth');
    if (sends === 1) return Response.json({ name: 'projects/impo-unit-test/messages/1' });
    if (sends === 2) return Response.json({ error: { details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }, { status: 404 });
    return Response.json({ error: {} }, { status: 429, headers: { 'Retry-After': '90' } });
  });
  assert.equal((await sender.send(input)).status, 'sent');
  assert.equal((await sender.send(input)).invalidToken, true);
  assert.equal((await sender.send(input)).retryAfterMs, 90_000); assert.equal(authCalls, 1);
});
test('notification input rejects unknown fields, invalid revisions, unsupported platforms and malformed tokens', () => {
  assert.throws(() => settingsInput({}), /Choose notification/);
  assert.throws(() => settingsInput({ chat: true, arbitrary: false }), /Choose notification/);
  assert.throws(() => registrationInput({ installationSecret: randomUUID(), registrationId: randomUUID(), revision: 0 }), /Invalid notification/);
  assert.throws(() => parseFCMCredentials('{"private_key":"sensitive-malformed-value"}'), error => error instanceof Error && !error.message.includes('sensitive'));
});
