import { setTimeout as delay } from 'node:timers/promises';
import type { Utterance } from '../db/entities/listening.js';

export interface TranscriptionResult { transcript: string; utterances: Utterance[]; model: string }

export interface Transcriber {
  readonly model: string;
  transcribe(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<TranscriptionResult>;
}

export interface BatchTranscriber extends Transcriber {
  transcribeMany(items: Array<{ audio: Buffer; mimeType: string }>, signal: AbortSignal): Promise<TranscriptionResult>;
}

/** A retryable failure (network, 429, 5xx) versus one that will fail the same way again. */
export class TranscriptionError extends Error {
  constructor(message: string, readonly retryable: boolean, readonly code = "transcription_failed") { super(message); }
}

interface WordInfo { type?: string; text?: string; speaker?: string; start_offset?: string; end_offset?: string; start_index?: number; end_index?: number }

const seconds = (value: string | undefined) => {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value ?? '');
  return match ? Math.round(Number(match[1]) * 1000) : 0;
};

/** Consecutive words by the same speaker become one utterance, sliced from the text itself. */
export function groupUtterances(text: string, words: WordInfo[]): Utterance[] {
  const result: Utterance[] = [];
  let current: { speaker: string | null; startMs: number; endMs: number; from: number; to: number } | undefined;
  for (const word of words) {
    if (word.type !== 'word_info' || typeof word.start_index !== 'number' || typeof word.end_index !== 'number') continue;
    const speaker = word.speaker ?? null;
    if (current && current.speaker === speaker) {
      current.endMs = seconds(word.end_offset);
      current.to = word.end_index;
    } else {
      if (current) result.push({ speaker: current.speaker, startMs: current.startMs, endMs: current.endMs, text: text.slice(current.from, current.to).trim() });
      current = { speaker, startMs: seconds(word.start_offset), endMs: seconds(word.end_offset), from: word.start_index, to: word.end_index };
    }
  }
  if (current) result.push({ speaker: current.speaker, startMs: current.startMs, endMs: current.endMs, text: text.slice(current.from, current.to).trim() });
  return result.filter(utterance => utterance.text);
}

/**
 * Gemini 3.5 Transcribe through the Files API and the Interactions endpoint.
 * The uploaded file is deleted once transcription finishes, whatever the outcome.
 */
export class GeminiTranscriber implements Transcriber {
  readonly model = 'gemini-3.5-transcribe';
  constructor(private readonly options: { apiKey: string; baseURL: string; timeoutMs: number }) {}

  async transcribe(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<TranscriptionResult> {
    return this.transcribeMany([{ audio, mimeType }], signal);
  }

  async transcribeMany(items: Array<{ audio: Buffer; mimeType: string }>, signal: AbortSignal): Promise<TranscriptionResult> {
    const files: Array<{ name: string; uri: string; mimeType: string; state?: string }> = [];
    try {
      for (const item of items) {
        const file = await this.upload(item.audio, item.mimeType, signal);
        files.push({ ...file, mimeType: item.mimeType });
        let state = file.state;
        for (let attempt = 0; state === 'PROCESSING' && attempt < 30; attempt++) {
          await delay(1000, undefined, { signal });
          const status = await this.request(`${this.options.baseURL}/v1beta/${file.name}`, {}, signal);
          state = (await status.json() as { state?: string }).state;
        }
        if (state && state !== 'ACTIVE') throw new TranscriptionError('Audio file is not ready for transcription', state === 'PROCESSING', 'audio_not_ready');
      }
      const response = await this.request(`${this.options.baseURL}/v1beta/interactions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, store: false,
          input: files.map(file => ({ type: 'audio', uri: file.uri, mime_type: file.mimeType })),
          generation_config: { transcription_config: { mode: { type: 'verbatim' } } },
        }),
      }, signal);
      const body = await response.json() as { object?: string; status?: string; steps?: Array<{ content?: Array<{ type?: string; text?: string; annotations?: WordInfo[] }> }> };
      if (body.status && body.status !== 'completed') throw new TranscriptionError('Transcription did not complete', true, 'interaction_incomplete');
      const parts = (body.steps ?? []).flatMap(step => step.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string');
      // A completed interaction with no steps is Gemini's valid silence result.
      if (!Array.isArray(body.steps) && !(body.status === 'completed' && body.object === 'interaction')) throw new TranscriptionError('Invalid transcription response', true, 'invalid_response');
      if (parts.length === 0 && body.status !== 'completed') throw new TranscriptionError('Invalid transcription response', true, 'invalid_response');
      const transcript = parts.map(part => part.text!).join('\n').trim();
      // Multi-file offsets are not a documented wall-clock timeline. Keep source
      // timestamps on the batch and do not publish guessed speaker/time mapping.
      const utterances = items.length === 1 ? parts.flatMap(part => groupUtterances(part.text!, part.annotations ?? [])) : [];
      return { transcript, utterances, model: this.model };
    } finally {
      await Promise.all(files.map(file => this.request(`${this.options.baseURL}/v1beta/${file.name}`, { method: 'DELETE' }, AbortSignal.timeout(10_000)).catch(() => undefined)));
    }
  }

  private async upload(audio: Buffer, mimeType: string, signal: AbortSignal): Promise<{ name: string; uri: string; state?: string }> {
    const start = await this.request(`${this.options.baseURL}/upload/v1beta/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': String(audio.length), 'X-Goog-Upload-Header-Content-Type': mimeType,
      },
      body: JSON.stringify({ file: { display_name: 'listening-segment' } }),
    }, signal);
    const uploadURL = start.headers.get('x-goog-upload-url');
    if (!uploadURL) throw new TranscriptionError('Upload session did not return an upload URL', true);
    const finished = await this.request(uploadURL, {
      method: 'POST',
      headers: { 'Content-Length': String(audio.length), 'X-Goog-Upload-Offset': '0', 'X-Goog-Upload-Command': 'upload, finalize' },
      body: new Uint8Array(audio),
    }, signal, false);
    const body = await finished.json() as { file?: { name?: string; uri?: string; state?: string } };
    if (!body.file?.name || !body.file.uri) throw new TranscriptionError('Upload did not return a file', true);
    if (!/^files\/[a-zA-Z0-9_-]+$/.test(body.file.name)) throw new TranscriptionError('Invalid uploaded file name', false);
    return { name: body.file.name, uri: body.file.uri, ...(body.file.state ? { state: body.file.state } : {}) };
  }

  private async request(url: string, init: RequestInit, signal: AbortSignal, withKey = true): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), ...(withKey ? { 'x-goog-api-key': this.options.apiKey } : {}) },
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new TranscriptionError('Transcription service is unreachable', true, 'provider_unreachable');
    }
    if (!response.ok) {
      // Never include the response body: it can echo request content.
      throw new TranscriptionError(`Transcription service returned ${response.status}`, response.status === 429 || response.status >= 500, `provider_http_${response.status}`);
    }
    return response;
  }
}

/** Local development and tests: deterministic text, no network, no audio leaves the machine. */
export class DevelopmentTranscriber implements Transcriber {
  readonly model = 'development';
  async transcribeMany(items: Array<{ audio: Buffer; mimeType: string }>): Promise<TranscriptionResult> {
    return this.transcribe(Buffer.concat(items.map(item => item.audio)));
  }
  async transcribe(audio: Buffer): Promise<TranscriptionResult> {
    const text = `Development transcript for ${audio.length} bytes of audio.`;
    return { transcript: text, utterances: [{ speaker: 'spk:0', startMs: 0, endMs: 1000, text }], model: this.model };
  }
}
