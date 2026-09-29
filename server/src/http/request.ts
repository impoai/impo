import type { IncomingMessage, ServerResponse } from 'node:http';
import { ServiceError } from '../errors.js';

const maxBodyBytes = 64 * 1024;
export type JsonObject = Record<string, unknown>;

export function sendJSON(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/** Bounded body reads let us send a JSON 413/408 before closing the connection. */
export async function readJSON(req: IncomingMessage, timeoutMs: number, limit = maxBodyBytes): Promise<JsonObject> {
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?\s*$/i.test(req.headers['content-type'] ?? '')) {
    throw new ServiceError(415, 'unsupported_media_type', 'Expected application/json');
  }
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > limit) {
    throw new ServiceError(413, 'request_too_large', 'JSON body exceeds size limit');
  }
  const bytes = await readBody(req, limit, timeoutMs, 'JSON body exceeds size limit');
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as JsonObject;
  } catch {
    throw new ServiceError(400, 'invalid_request', 'Expected a UTF-8 JSON object');
  }
}

export function onlyFields(value: JsonObject, fields: readonly string[]): void {
  if (Object.keys(value).some(key => !fields.includes(key))) {
    throw new ServiceError(400, 'invalid_request', 'Request contains unsupported fields');
  }
}

export function requiredString(value: JsonObject, key: string, maxLength: number): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim().length === 0 || result.length > maxLength || result.includes('\0')) {
    throw new ServiceError(400, 'invalid_request', `${key} must be a nonempty string of at most ${maxLength} characters without NUL`);
  }
  return result;
}

export function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new ServiceError(400, 'invalid_request', 'Expected a UUID identifier');
  }
  return value.toLowerCase();
}

export function integerQuery(url: URL, name: string, fallback: number, min: number, max: number): number {
  const values = url.searchParams.getAll(name);
  if (!values.length) return fallback;
  if (values.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(values[0])) {
    throw new ServiceError(400, 'invalid_request', `${name} must be an integer between ${min} and ${max}`);
  }
  const value = Number(values[0]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ServiceError(400, 'invalid_request', `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Reads a bounded request body; the caller validates its type and content. */
export function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number, tooLarge: string): Promise<Buffer> {
  const declaredLength = req.headers['content-length'];
  if (declaredLength !== undefined && Number(declaredLength) > maxBytes) {
    return Promise.reject(new ServiceError(413, 'request_too_large', tooLarge));
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const timeout = setTimeout(() => finish(new ServiceError(408, 'request_timeout', 'Request body timed out', true)), timeoutMs);
    timeout.unref();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('aborted', onAborted);
      if (error) { req.pause(); reject(error); }
      else resolve(Buffer.concat(chunks, length));
    };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) { finish(new ServiceError(413, 'request_too_large', tooLarge)); return; }
      chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onAborted = () => finish(new ServiceError(400, 'request_aborted', 'Request was interrupted', true));
    const onError = () => finish(new ServiceError(400, 'request_aborted', 'Request was interrupted', true));
    const onClose = () => {
      // Node may emit ECONNRESET after aborted; retain the error listener until close.
      req.off('error', onError);
      if (!settled) onAborted();
    };
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('aborted', onAborted);
    req.once('error', onError);
    req.once('close', onClose);
  });
}
