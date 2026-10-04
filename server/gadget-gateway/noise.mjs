// Noise_XX_25519_AESGCM_SHA256 responder, the gateway side of the gadget link.
// The device authenticates with a bearer at the WebSocket upgrade; the Noise
// static keys are ephemeral and carry no identity.

import { concat } from './proto.mjs';

const PROTOCOL_NAME = new TextEncoder().encode('Noise_XX_25519_AESGCM_SHA256');
const KEY_LENGTH = 32;
const TAG_LENGTH = 16;
const EMPTY = new Uint8Array();

async function sha256(data) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data));
}

async function hmac(key, data) {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data));
}

async function hkdf2(chainingKey, input) {
  const temp = await hmac(chainingKey, input);
  const first = await hmac(temp, Uint8Array.of(1));
  const second = await hmac(temp, concat(first, Uint8Array.of(2)));
  return [first, second];
}

function nonceIv(nonce) {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setBigUint64(4, BigInt(nonce), false);
  return iv;
}

// One direction of the transport. `rawKey` and `nonce` are the whole state, so
// a session survives Durable Object hibernation by persisting them.
export class CipherState {
  constructor(rawKey, nonce = 0) {
    this.rawKey = rawKey;
    this.nonce = nonce;
    this.key = null;
  }

  async #params(associatedData) {
    this.key ??= await crypto.subtle.importKey('raw', this.rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = nonceIv(this.nonce);
    this.nonce += 1;
    return { name: 'AES-GCM', iv, additionalData: associatedData, tagLength: TAG_LENGTH * 8 };
  }

  async encrypt(plaintext, associatedData = EMPTY) {
    const params = await this.#params(associatedData);
    return new Uint8Array(await crypto.subtle.encrypt(params, this.key, plaintext));
  }

  async decrypt(ciphertext, associatedData = EMPTY) {
    const params = await this.#params(associatedData);
    return new Uint8Array(await crypto.subtle.decrypt(params, this.key, ciphertext));
  }
}

class SymmetricState {
  cipher = null;

  async initialize() {
    const padded = new Uint8Array(32);
    padded.set(PROTOCOL_NAME);
    this.chainingKey = padded;
    this.hash = await sha256(padded); // MixHash of the empty prologue
  }

  async mixHash(data) {
    this.hash = await sha256(concat(this.hash, data));
  }

  async mixKey(input) {
    const [chainingKey, key] = await hkdf2(this.chainingKey, input);
    this.chainingKey = chainingKey;
    this.cipher = new CipherState(key);
  }

  async encryptAndHash(plaintext) {
    const ciphertext = this.cipher ? await this.cipher.encrypt(plaintext, this.hash) : plaintext;
    await this.mixHash(ciphertext);
    return ciphertext;
  }

  async decryptAndHash(ciphertext) {
    const plaintext = this.cipher ? await this.cipher.decrypt(ciphertext, this.hash) : ciphertext;
    await this.mixHash(ciphertext);
    return plaintext;
  }
}

export async function generateKeyPair() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']);
  return { privateKey: pair.privateKey, publicKey: new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)) };
}

export async function dh(privateKey, publicKeyBytes) {
  if (publicKeyBytes.length !== KEY_LENGTH) throw new Error('x25519: invalid public key length');
  const publicKey = await crypto.subtle.importKey('raw', publicKeyBytes, { name: 'X25519' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256));
  // A low-order public key yields an all-zero secret; reject it.
  if (shared.every((byte) => byte === 0)) throw new Error('x25519: rejected low-order public key');
  return shared;
}

export class NoiseResponder {
  state = new SymmetricState();

  // <- e ; -> e, ee, s, es
  async readMessage1AndWriteMessage2(message1) {
    if (message1.length < KEY_LENGTH) throw new Error('noise: message 1 too short');
    const { state } = this;
    await state.initialize();
    const remoteEphemeral = message1.subarray(0, KEY_LENGTH);
    await state.mixHash(remoteEphemeral);
    await state.decryptAndHash(message1.subarray(KEY_LENGTH));

    this.ephemeral = await generateKeyPair();
    await state.mixHash(this.ephemeral.publicKey);
    await state.mixKey(await dh(this.ephemeral.privateKey, remoteEphemeral));

    const staticKey = await generateKeyPair();
    const encryptedStatic = await state.encryptAndHash(staticKey.publicKey);
    await state.mixKey(await dh(staticKey.privateKey, remoteEphemeral));
    const encryptedPayload = await state.encryptAndHash(EMPTY);
    return concat(this.ephemeral.publicKey, encryptedStatic, encryptedPayload);
  }

  // <- s, se ; then split into { send, recv } transport ciphers.
  async readMessage3(message3) {
    const staticLength = KEY_LENGTH + TAG_LENGTH;
    if (message3.length < staticLength + TAG_LENGTH) throw new Error('noise: message 3 too short');
    const { state } = this;
    const remoteStatic = await state.decryptAndHash(message3.subarray(0, staticLength));
    await state.mixKey(await dh(this.ephemeral.privateKey, remoteStatic));
    await state.decryptAndHash(message3.subarray(staticLength));
    const [initiatorToResponder, responderToInitiator] = await hkdf2(state.chainingKey, EMPTY);
    return { send: new CipherState(responderToInitiator), recv: new CipherState(initiatorToResponder) };
  }
}
