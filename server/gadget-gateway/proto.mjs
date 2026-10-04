// Wire encoding for the gadget link protocol: protobuf-style messages carried
// inside the Noise session. Field numbers match the open-source gadget SDK.

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export const MAX_CHUNK_PAYLOAD = 65489;
const MAX_TOTAL_CHUNKS = 256;
const MAX_PENDING_ASSEMBLIES = 16;
const MAX_ASSEMBLY_BYTES = 16 * 1024 * 1024;
const MAX_CONTROL_MESSAGE = 4 * 1024 * 1024;

export function concat(...parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function varint(value) {
  let rest = BigInt.asUintN(64, BigInt(value));
  const bytes = [];
  do {
    const byte = Number(rest & 0x7fn);
    rest >>= 7n;
    bytes.push(rest ? byte | 0x80 : byte);
  } while (rest);
  return Uint8Array.from(bytes);
}

function varintField(field, value) {
  return concat(varint(field << 3), varint(value));
}

function bytesField(field, bytes) {
  return concat(varint((field << 3) | 2), varint(bytes.length), bytes);
}

function readVarint(data, offset) {
  let value = 0n;
  for (let index = 0; index < 10; index += 1) {
    if (offset >= data.length) throw new Error('truncated varint');
    const byte = data[offset];
    offset += 1;
    value |= BigInt(byte & 0x7f) << BigInt(7 * index);
    if (!(byte & 0x80)) return [BigInt.asUintN(64, value), offset];
  }
  throw new Error('malformed varint');
}

// Yields [fieldNumber, value]: a bigint for varints, a Uint8Array for
// length-delimited fields. Fixed-width fields are skipped.
function* fields(data) {
  let offset = 0;
  while (offset < data.length) {
    let key;
    [key, offset] = readVarint(data, offset);
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (wireType === 0) {
      let value;
      [value, offset] = readVarint(data, offset);
      yield [field, value];
    } else if (wireType === 2) {
      let length;
      [length, offset] = readVarint(data, offset);
      const end = offset + Number(length);
      if (end > data.length) throw new Error('truncated field');
      yield [field, data.subarray(offset, end)];
      offset = end;
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
      if (offset > data.length) throw new Error('truncated field');
    } else {
      throw new Error('invalid wire type');
    }
  }
}

const asBytes = (value) => {
  if (!(value instanceof Uint8Array)) throw new Error('wrong wire type');
  return value;
};
const asInt = (value) => {
  if (typeof value !== 'bigint') throw new Error('wrong wire type');
  return Number(BigInt.asIntN(64, value));
};

// -- Chunking ---------------------------------------------------------------

export function encodeNoiseFrames(payload) {
  const chunkId = BigInt.asIntN(64, crypto.getRandomValues(new BigUint64Array(1))[0]);
  const total = Math.max(1, Math.ceil(payload.length / MAX_CHUNK_PAYLOAD));
  if (total > MAX_TOTAL_CHUNKS) throw new Error('payload too large for noise framing');
  const frames = [];
  for (let index = 0; index < total; index += 1) {
    const chunk = payload.subarray(index * MAX_CHUNK_PAYLOAD, (index + 1) * MAX_CHUNK_PAYLOAD);
    frames.push(concat(
      chunkId ? varintField(1, chunkId) : new Uint8Array(),
      index ? varintField(2, index) : new Uint8Array(),
      varintField(3, total),
      chunk.length ? bytesField(4, chunk) : new Uint8Array(),
    ));
  }
  return frames;
}

export class NoiseFrameDecoder {
  pending = new Map();

  // Returns the reassembled payload once every chunk arrived, otherwise null.
  decode(data) {
    let chunkId = 0n;
    let index = 0;
    let total = 1;
    let payload = new Uint8Array();
    for (const [field, value] of fields(data)) {
      if (field === 1) chunkId = BigInt.asIntN(64, value);
      else if (field === 2) index = asInt(value);
      else if (field === 3) total = asInt(value);
      else if (field === 4) payload = asBytes(value);
    }
    if (total < 1 || total > MAX_TOTAL_CHUNKS || index < 0 || index >= total) {
      throw new Error('invalid noise frame chunk');
    }
    if (total === 1) return payload;
    let assembly = this.pending.get(chunkId);
    if (!assembly) {
      if (this.pending.size >= MAX_PENDING_ASSEMBLIES) throw new Error('too many pending assemblies');
      assembly = { chunks: new Map(), total, bytes: 0 };
      this.pending.set(chunkId, assembly);
    }
    if (assembly.total !== total || assembly.chunks.has(index)) throw new Error('inconsistent chunks');
    assembly.bytes += payload.length;
    if (assembly.bytes > MAX_ASSEMBLY_BYTES) throw new Error('assembly exceeded byte budget');
    assembly.chunks.set(index, payload);
    if (assembly.chunks.size < total) return null;
    this.pending.delete(chunkId);
    return concat(...Array.from({ length: total }, (_, position) => assembly.chunks.get(position)));
  }
}

// -- Service envelopes --------------------------------------------------------

function decodeHeaders(raw) {
  let key = '';
  let value = '';
  for (const [field, bytes] of fields(raw)) {
    if (field === 1) key = decoder.decode(asBytes(bytes));
    else if (field === 2) value = decoder.decode(asBytes(bytes));
  }
  return [key.toLowerCase(), value];
}

function decodeRequest(raw) {
  const request = { verb: '', path: '', headers: {}, body: new Uint8Array(), endBody: false };
  for (const [field, value] of fields(raw)) {
    if (field === 1) request.verb = decoder.decode(asBytes(value));
    else if (field === 2) request.path = decoder.decode(asBytes(value));
    else if (field === 3) {
      const [key, headerValue] = decodeHeaders(asBytes(value));
      request.headers[key] = headerValue;
    } else if (field === 4) request.body = asBytes(value);
    else if (field === 5) request.endBody = asInt(value) !== 0;
  }
  return request;
}

function decodeBodyChunk(raw) {
  const chunk = { data: new Uint8Array(), endBody: false };
  for (const [field, value] of fields(raw)) {
    if (field === 1) chunk.data = asBytes(value);
    else if (field === 2) chunk.endBody = asInt(value) !== 0;
  }
  return chunk;
}

function decodeReset(raw) {
  const reset = { code: 0, reason: '' };
  for (const [field, value] of fields(raw)) {
    if (field === 1) reset.code = asInt(value);
    else if (field === 2) reset.reason = decoder.decode(asBytes(value));
  }
  return reset;
}

// Device -> gateway: ServiceRequest{payload: ServiceFrame}.
export function decodeDeviceFrame(data) {
  let payload = new Uint8Array();
  for (const [field, value] of fields(data)) {
    if (field === 2) payload = asBytes(value);
  }
  const frame = { streamId: 0, kind: null, value: null };
  for (const [field, value] of fields(payload)) {
    if (field === 1) frame.streamId = asInt(value);
    else if (field === 2) Object.assign(frame, { kind: 'request', value: decodeRequest(asBytes(value)) });
    else if (field === 4) Object.assign(frame, { kind: 'body_chunk', value: decodeBodyChunk(asBytes(value)) });
    else if (field === 5) Object.assign(frame, { kind: 'reset', value: decodeReset(asBytes(value)) });
  }
  return frame;
}

// Gateway -> device: ServiceResponse{payload: ServiceFrame}.
function gatewayFrame(streamId, field, body) {
  return bytesField(1, concat(streamId ? varintField(1, streamId) : new Uint8Array(), bytesField(field, body)));
}

export function encodeResponse(streamId, { status, body = new Uint8Array(), endBody = false }) {
  return gatewayFrame(streamId, 3, concat(
    status ? varintField(1, status) : new Uint8Array(),
    body.length ? bytesField(3, body) : new Uint8Array(),
    endBody ? varintField(4, 1) : new Uint8Array(),
  ));
}

export function encodeBodyChunk(streamId, data, endBody = false) {
  return gatewayFrame(streamId, 4, concat(
    data.length ? bytesField(1, data) : new Uint8Array(),
    endBody ? varintField(2, 1) : new Uint8Array(),
  ));
}

// -- Control messages: JSON prefixed with a little-endian u32 length ----------

export function encodeControlMessage(message) {
  const json = encoder.encode(JSON.stringify(message));
  const out = new Uint8Array(4 + json.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  return out;
}

export class ControlMessageDecoder {
  buffer = new Uint8Array();

  feed(data) {
    this.buffer = concat(this.buffer, data);
    const messages = [];
    while (this.buffer.length >= 4) {
      const length = new DataView(this.buffer.buffer, this.buffer.byteOffset).getUint32(0, true);
      if (length > MAX_CONTROL_MESSAGE) throw new Error('control message too large');
      if (this.buffer.length < 4 + length) break;
      const raw = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.slice(4 + length);
      if (!raw.length) continue; // keepalive
      try {
        const message = JSON.parse(decoder.decode(raw));
        if (message && typeof message === 'object' && !Array.isArray(message)) messages.push(message);
      } catch {
        // A malformed message is dropped; the stream stays usable.
      }
    }
    return messages;
  }
}
