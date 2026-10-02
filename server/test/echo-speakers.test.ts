import assert from 'node:assert/strict';
import test from 'node:test';
import { emptySpeakerReview, parseSpeakerReview, personalTranscript, speakerUtterances } from '../src/listening/speakers.js';
import { groupUtterances } from '../src/listening/transcriber.js';
import { joinAudio } from '../src/listening/audio-join.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const utterances = [
  { speaker: 'a', startMs: 0, endMs: 1000, text: 'I prefer walking.' },
  { speaker: 'b', startMs: 1100, endMs: 2000, text: 'I prefer cycling.' },
  { speaker: null, startMs: 2100, endMs: 3000, text: 'Unclear overlap.' },
  { speaker: 'a', startMs: 3100, endMs: 4000, text: 'This passage was misassigned.' },
];
test('personal Echo evidence requires explicit confirmation, includes only that voice, and respects exclusions', () => {
  assert.equal(personalTranscript({ utterances }), '');
  assert.equal(personalTranscript({ utterances: utterances.slice(0, 1), speakerReview: emptySpeakerReview() }), '');
  const review = parseSpeakerReview({ revision: 0, status: 'confirmed', selfSpeakerIds: ['a'], excludedUtteranceIds: ['u4'] }, utterances);
  assert.equal(personalTranscript({ utterances, speakerReview: { ...review, revision: 1 } }), 'I prefer walking.');
  assert.equal(personalTranscript({ utterances, speakerReview: { ...review, revision: 2, status: 'not_present', selfSpeakerIds: [] } }), '');
  assert.equal(personalTranscript({ utterances: [], speakerReview: { ...review, revision: 1 } }), '');
  assert.deepEqual(speakerUtterances(utterances).map(turn => turn.id), ['u1', 'u2', 'u3', 'u4']);
});

test('speaker review rejects invented voices, unknown passages, conflicting states and unexpected fields', () => {
  const base = { revision: 0, status: 'confirmed', selfSpeakerIds: ['a'], excludedUtteranceIds: [] };
  for (const changes of [
    { selfSpeakerIds: ['missing'] }, { selfSpeakerIds: ['a', 'a'] }, { selfSpeakerIds: [] },
    { status: 'unconfirmed' }, { revision: -1 }, { revision: 0.5 }, { revision: '0' },
    { excludedUtteranceIds: ['u900'] }, { userId: 'other' }, { status: 'automatic' },
  ]) assert.throws(() => parseSpeakerReview({ ...base, ...changes }, utterances));
  assert.equal(parseSpeakerReview(emptySpeakerReview(), utterances).status, 'unconfirmed');
});

test('word annotations preserve speaker changes and CJK punctuation', () => {
  const turns = groupUtterances('你好。Hello.再见。', [
    { type: 'word_info', speaker: 'A', start_index: 0, end_index: 9, start_offset: '0s', end_offset: '1s' },
    { type: 'word_info', speaker: 'B', start_index: 9, end_index: 15, start_offset: '1.2s', end_offset: '2s' },
    { type: 'word_info', speaker: 'A', start_index: 15, end_index: 24, start_offset: '2.1s', end_offset: '3s' },
  ]);
  assert.deepEqual(turns.map(turn => [turn.speaker, turn.text]), [['A', '你好。'], ['B', 'Hello.'], ['A', '再见。']]);
});

test('sentence boundaries allow passage exclusion without dropping Unicode or attributing annotation gaps', () => {
  const text = '🙂 Hi. Bye. unknown 最后';
  const word = (value: string, from: number, start: string, end: string) => ({ type: 'word_info', speaker: 'A', start_index: from, end_index: from + Buffer.byteLength(value), start_offset: start, end_offset: end });
  const turns = groupUtterances(text, [word('🙂 Hi.', 0, '0s', '1s'), word('Bye.', 9, '1s', '2s'), word('最后', 22, '4s', '5s')]);
  assert.deepEqual(turns.map(t => [t.speaker, t.text]), [['A', '🙂 Hi.'], ['A', 'Bye.'], [null, 'unknown'], ['A', '最后']]);
  const review = { revision: 1, status: 'confirmed' as const, selfSpeakerIds: ['A'], excludedUtteranceIds: ['u2'] };
  assert.equal(personalTranscript({ utterances: turns, speakerReview: review }), '🙂 Hi.\n最后');
  assert.deepEqual(groupUtterances('你好', [word('你', 1, '0s', '1s')]), [], 'invalid byte boundaries cannot produce personal speech');
});

function wav(sample: number) {
  const buffer = Buffer.alloc(44 + 3200);
  buffer.write('RIFF'); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36); buffer.writeUInt32LE(3200, 40);
  for (let at = 44; at < buffer.length; at += 2) buffer.writeInt16LE(sample, at);
  return buffer;
}
test('audio joining creates one ordered media timeline and rejects invalid or cancelled audio', async () => {
  const joined = await joinAudio([{ audio: wav(100) }, { audio: wav(-200) }], AbortSignal.timeout(10000));
  assert.equal(joined.length, 6444);
  assert.equal(joined.readUInt32LE(40), 6400);
  assert.equal(joined.readInt16LE(44), 100);
  assert.equal(joined.readInt16LE(3244), -200);
  await assert.rejects(joinAudio([{ audio: Buffer.from('not audio') }], AbortSignal.timeout(10000)));
  await assert.rejects(joinAudio([{ audio: wav(1) }], AbortSignal.abort()));
});

test('M4A with trailing metadata remains decodable when joining captured segments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'impo-echo-decode-'));
  try {
    const file = join(directory, 'tone.m4a');
    await promisify(execFile)('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:a', 'aac', file]);
    const audio = await readFile(file);
    const combined = await joinAudio([{ audio }, { audio }], AbortSignal.timeout(10000));
    assert.ok(combined.length >= 320044 && combined.length < 324000, 'All ten seconds survive M4A decoding, allowing encoder padding');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
