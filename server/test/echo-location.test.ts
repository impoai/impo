import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import test from 'node:test';
import { parseEchoLocations, parseLocationLabel, echoLocationContext } from '../src/listening/location.js';
import { parseListeningBatch } from '../src/listening/batch-input.js';

const start = Date.parse('2026-09-28T10:00:00Z'), end = start + 60_000;
const span = { from:new Date(start).toISOString(),to:new Date(end).toISOString(),capturedAt:new Date(start-1000).toISOString(),accuracyMeters:80,source:'device',granularity:'district',city:'Shanghai',country:'China',district:"Jing'an" };
test('locations preserve recording intervals and reject coordinates, stale fixes and unsupported precision', () => {
  assert.deepEqual(parseEchoLocations([span],start,end),[span]);
  assert.equal(parseEchoLocations(undefined,start,end),undefined);
  for (const invalid of [
    {...span,latitude:31}, {...span,longitude:121}, {...span,accuracyMeters:501}, {...span,accuracyMeters:-1},
    {...span,capturedAt:new Date(start-120001).toISOString()}, {...span,capturedAt:new Date(start+1).toISOString()},
    {...span,from:new Date(start-1).toISOString()}, {...span,to:new Date(end+1).toISOString()},
    {...span,city:'\nShanghai'}, {...span,granularity:'city'}, {...span,source:'manual'},
  ]) assert.throws(()=>parseEchoLocations([invalid],start,end),{code:'invalid_location'});
  assert.throws(()=>parseEchoLocations([span,span],start,end),{code:'invalid_location'});
  assert.throws(()=>parseEchoLocations(Array(17).fill(span),start,end),{code:'invalid_location'});
});
test('manual labels remain annotations and bounded agent context explicitly reports omitted spans', () => {
  assert.equal(parseLocationLabel(' Home '),'Home'); assert.equal(parseLocationLabel('  '),null);
  for(const value of [false,{},'x'.repeat(81),'Home\nOffice']) assert.throws(()=>parseLocationLabel(value));
  const locations = parseEchoLocations([span],start,end)!;
  assert.deepEqual(echoLocationContext({locationLabel:'Office',segments:[{locations},{locations}]},1),{label:'Office',source:'manual',spans:locations,truncated:true});
  assert.equal(echoLocationContext({segments:[]}),undefined);
});
test('legacy batches retain their canonical hash; location changes require a new immutable batch', () => {
  const item={segmentId:randomUUID(),startedAt:new Date(start).toISOString(),endedAt:new Date(end).toISOString(),mimeType:'audio/mp4',audio:'YWJj'};
  const input={batchId:randomUUID(),streamId:randomUUID(),sequence:1,sessionId:randomUUID(),items:[item]};
  const old = parseListeningBatch(input,'owner');
  const located = parseListeningBatch({...input,items:[{...item,locations:[span]}]},'owner');
  assert.equal(old.contentHash,createHash('sha256').update(JSON.stringify(input)).digest('hex'));
  assert.notEqual(old.contentHash,located.contentHash);
  assert.equal(located.contentHash,parseListeningBatch(JSON.parse(JSON.stringify({...input,items:[{...item,locations:[span]}]})),'owner').contentHash);
});
