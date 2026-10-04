import assert from 'node:assert/strict';
import test from 'node:test';

import { CipherState, NoiseResponder, dh, generateKeyPair } from './noise.mjs';
import {
  ControlMessageDecoder, MAX_CHUNK_PAYLOAD, NoiseFrameDecoder, concat, decodeDeviceFrame,
  encodeControlMessage, encodeNoiseFrames,
} from './proto.mjs';
import { secretsEqual, signToken, verifyToken } from './tokens.mjs';

const text = (value) => new TextEncoder().encode(value);

// Independent initiator written from the Noise XX pattern, so the test does
// not share handshake code with the responder under test.
async function initiatorHandshake(responder) {
  const sha256 = async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  const hmac = async (key, data) => {
    const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
  };
  let chainingKey = new Uint8Array(32);
  chainingKey.set(text('Noise_XX_25519_AESGCM_SHA256'));
  let hash = await sha256(chainingKey);
  let cipher = null;
  const mixHash = async (data) => { hash = await sha256(concat(hash, data)); };
  const mixKey = async (input) => {
    const temp = await hmac(chainingKey, input);
    chainingKey = await hmac(temp, Uint8Array.of(1));
    cipher = new CipherState(await hmac(temp, concat(chainingKey, Uint8Array.of(2))));
  };
  const seal = async (plain) => {
    const sealed = cipher ? await cipher.encrypt(plain, hash) : plain;
    await mixHash(sealed);
    return sealed;
  };
  const open = async (sealed) => {
    const plain = await cipher.decrypt(sealed, hash);
    await mixHash(sealed);
    return plain;
  };

  const ephemeral = await generateKeyPair();
  await mixHash(ephemeral.publicKey);
  await seal(new Uint8Array());
  const message2 = await responder.readMessage1AndWriteMessage2(ephemeral.publicKey);

  const remoteEphemeral = message2.subarray(0, 32);
  await mixHash(remoteEphemeral);
  await mixKey(await dh(ephemeral.privateKey, remoteEphemeral));
  const remoteStatic = await open(message2.subarray(32, 80));
  await mixKey(await dh(ephemeral.privateKey, remoteStatic));
  await open(message2.subarray(80));

  const staticKey = await generateKeyPair();
  const sealedStatic = await seal(staticKey.publicKey);
  await mixKey(await dh(staticKey.privateKey, remoteEphemeral));
  const gateway = await responder.readMessage3(concat(sealedStatic, await seal(new Uint8Array())));

  const temp = await hmac(chainingKey, new Uint8Array());
  const first = await hmac(temp, Uint8Array.of(1));
  const second = await hmac(temp, concat(first, Uint8Array.of(2)));
  return { gateway, device: { send: new CipherState(first), recv: new CipherState(second) } };
}

test('Noise XX handshake yields matching transport ciphers', async () => {
  const { gateway, device } = await initiatorHandshake(new NoiseResponder());
  for (const message of ['first', 'second']) {
    assert.deepEqual(await gateway.recv.decrypt(await device.send.encrypt(text(message))), text(message));
    assert.deepEqual(await device.recv.decrypt(await gateway.send.encrypt(text(message))), text(message));
  }
});

test('a cipher restored from its key and nonce continues the session', async () => {
  const { gateway, device } = await initiatorHandshake(new NoiseResponder());
  await gateway.recv.decrypt(await device.send.encrypt(text('before hibernation')));
  const restored = new CipherState(gateway.recv.rawKey, gateway.recv.nonce);
  assert.deepEqual(await restored.decrypt(await device.send.encrypt(text('after'))), text('after'));
  await assert.rejects(new CipherState(gateway.recv.rawKey, 0).decrypt(await device.send.encrypt(text('stale'))));
});

test('a low-order public key is rejected', async () => {
  const { privateKey } = await generateKeyPair();
  await assert.rejects(dh(privateKey, new Uint8Array(32)));
});

test('large payloads are chunked and reassembled in any order', () => {
  const payload = crypto.getRandomValues(new Uint8Array(60000));
  const large = concat(payload, payload, payload);
  const frames = encodeNoiseFrames(large);
  assert.equal(frames.length, Math.ceil(large.length / MAX_CHUNK_PAYLOAD));
  const decoder = new NoiseFrameDecoder();
  assert.equal(decoder.decode(frames[2]), null);
  assert.equal(decoder.decode(frames[0]), null);
  assert.deepEqual(decoder.decode(frames[1]), large);
  assert.deepEqual(new NoiseFrameDecoder().decode(encodeNoiseFrames(text('small'))[0]), text('small'));
});

test('device request frames decode', () => {
  // ServiceRequest{payload: ServiceFrame{stream_id: 1, request{POST /link-control, x-app-id}}}
  const header = concat(Uint8Array.of(0x0a, 8), text('X-App-Id'), Uint8Array.of(0x12, 3), text('app'));
  const request = concat(
    Uint8Array.of(0x0a, 4), text('POST'), Uint8Array.of(0x12, 13), text('/link-control'),
    Uint8Array.of(0x1a, header.length), header, Uint8Array.of(0x22, 2), text('hi'), Uint8Array.of(0x28, 1),
  );
  const frame = concat(Uint8Array.of(0x08, 1, 0x12, request.length), request);
  const decoded = decodeDeviceFrame(concat(Uint8Array.of(0x12, frame.length), frame));
  assert.equal(decoded.streamId, 1);
  assert.equal(decoded.kind, 'request');
  assert.deepEqual(
    { ...decoded.value, body: new TextDecoder().decode(decoded.value.body) },
    { verb: 'POST', path: '/link-control', headers: { 'x-app-id': 'app' }, body: 'hi', endBody: true },
  );
});

test('control messages survive arbitrary chunk boundaries', () => {
  const stream = concat(
    encodeControlMessage({ method: 'link.register', id: '1' }),
    Uint8Array.of(0, 0, 0, 0), // keepalive
    encodeControlMessage({ method: 'link.result', id: '2', ok: true }),
  );
  const decoder = new ControlMessageDecoder();
  const messages = [];
  for (let offset = 0; offset < stream.length; offset += 7) messages.push(...decoder.feed(stream.subarray(offset, offset + 7)));
  assert.deepEqual(messages, [{ method: 'link.register', id: '1' }, { method: 'link.result', id: '2', ok: true }]);
});

test('tokens verify only with the right secret, type and lifetime', async () => {
  const token = await signToken('secret', 'device', { vm: 'user-1', pid: 'p1' }, 60);
  assert.equal(token.includes(':'), false);
  assert.equal((await verifyToken('secret', 'device', token)).vm, 'user-1');
  assert.equal(await verifyToken('other', 'device', token), null);
  assert.equal(await verifyToken('secret', 'refresh', token), null);
  assert.equal(await verifyToken('secret', 'device', await signToken('secret', 'device', {}, -1)), null);
  assert.equal(await verifyToken('secret', 'device', `${token}x`), null);
  assert.equal(await secretsEqual('a', 'a'), true);
  assert.equal(await secretsEqual('a', 'b'), false);
});
