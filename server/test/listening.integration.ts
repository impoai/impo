import { MaintenanceRepository } from '../src/db/repositories/maintenance-repository.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { createDatabase } from '../src/db/client.js';
import { listeningSegments, listeningBatches } from '../src/db/schema.js';
import { createApiServer } from '../src/http/api-server.js';
import { RuntimeRepository } from '../src/db/repositories/runtime-repository.js';
import { ListeningRepository } from '../src/db/repositories/listening-repository.js';
import { ListeningWorker } from '../src/listening/worker.js';
import { DevelopmentTranscriber, TranscriptionError } from '../src/listening/transcriber.js';
import { MemoryTranscriptArchive, transcriptKey } from '../src/listening/transcript-archive.js';

const database = createDatabase(process.env.DATABASE_URL!);
const runtime = new RuntimeRepository(database.db);
const repository = new ListeningRepository(database.db);
const server = createApiServer(runtime, { listening: repository, listeningEnabled: true });
let base: string;
const headers = { Authorization: 'Bearer instant-dev-alice' };
const start = new Date(Date.now() - 60_000).toISOString();
const end = new Date(Date.now() - 1000).toISOString();
const signal = new AbortController().signal;

async function upload(id = randomUUID(), audio = 'audio-test', user = 'alice') {
  const res = await fetch(`${base}/api/v1/listening/segments`, { method: 'POST', headers: {
    Authorization: `Bearer instant-dev-${user}`, 'Content-Type': 'audio/mp4',
    'X-Client-Segment-Id': id, 'X-Recording-Started-At': start, 'X-Recording-Ended-At': end,
  }, body: audio });
  return { status: res.status, body: await res.json() as any };
}
async function row(id: string) { return (await database.db.select().from(listeningSegments).where(eq(listeningSegments.id, id)))[0]!; }
async function remove(id: string, user = 'alice') {
  return fetch(`${base}/api/v1/listening/segments/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer instant-dev-${user}` } });
}

test.before(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
test.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await database.close(); });
test.beforeEach(async () => { await database.db.delete(listeningSegments); await database.db.delete(listeningBatches); });

test('durable upload receipts, conflicts, ownership, date range and audio removal after transcription', async () => {
  const id = randomUUID();
  const [first, duplicate] = await Promise.all([upload(id), upload(id)]);
  assert.equal(first.status, 202); assert.equal(duplicate.body.id, first.body.id);
  assert.equal((await upload(id, 'different')).status, 409);
  assert.equal((await upload(id, 'audio-test', 'bob')).status, 202);
  const worker = new ListeningWorker(repository, new DevelopmentTranscriber());
  await worker.tick(signal);
  const done = await row(first.body.id);
  assert.equal(done.status, 'transcribed'); assert.equal(done.audio, null);
  assert.match(done.transcript, /Development transcript/);
  assert.equal((await upload(id)).body.id, first.body.id);
  const query = new URLSearchParams({ from: start, to: new Date(Date.parse(start) + 86400_000).toISOString() });
  const page = await (await fetch(`${base}/api/v1/listening/segments?${query}`, { headers })).json() as any;
  assert.equal(page.segments.length, 1); assert.equal(page.segments[0].id, first.body.id);
  assert.ok(!('audio' in page.segments[0])); assert.ok(!('userId' in page.segments[0]));
  assert.equal((await remove(first.body.id, 'bob')).status, 404);
  assert.equal((await remove(first.body.id)).status, 200);
  assert.equal((await remove(first.body.id)).status, 200);
  assert.equal((await upload(id)).status, 410);
});

test('expired claims recover; old worker and deleted work cannot write a transcript', async () => {
  const uploaded = await upload();
  const first = (await repository.claim(60_000))!;
  assert.equal(await repository.claim(60_000), undefined);
  await database.db.update(listeningSegments).set({ leaseUntil: new Date(0) }).where(eq(listeningSegments.id, first.id));
  const second = (await repository.claim(60_000))!;
  assert.notEqual(first.leaseToken, second.leaseToken);
  await repository.complete(first, { transcript: 'stale', utterances: [], model: 'test' });
  assert.equal((await row(first.id)).status, 'transcribing');
  await remove(uploaded.body.id);
  await repository.complete(second, { transcript: 'late', utterances: [], model: 'test' });
  const deleted = await row(first.id);
  assert.equal(deleted.status, 'deleted'); assert.equal(deleted.transcript, ''); assert.equal(deleted.audio, null);
  assert.equal(await repository.renew(second, 60_000), false);
});

test('concurrent workers claim each segment once and retries are bounded', async () => {
  await upload(); await upload();
  const claims = await Promise.all([repository.claim(60_000), repository.claim(60_000), repository.claim(60_000)]);
  assert.equal(claims.filter(Boolean).length, 2);
  assert.equal(new Set(claims.filter(Boolean).map(job => job!.id)).size, 2);
  for (const job of claims.filter(Boolean)) await repository.fail(job!, true);
  assert.equal(await repository.claim(60_000), undefined);
  await database.db.update(listeningSegments).set({ availableAt: new Date(0), attempts: 4 });
  const failing = new ListeningWorker(repository, { model: 'test', async transcribe() { throw new TranscriptionError('upstream unavailable', true); } });
  await failing.tick(signal); await failing.tick(signal);
  const rows = await database.db.select().from(listeningSegments);
  assert.ok(rows.every(row => row.status === 'failed' && row.audio === null && row.attempts === 5));
});

test('lease renewal keeps a slow transcription exclusive', async () => {
  await upload();
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  const worker = new ListeningWorker(repository, { model: 'test', async transcribe() {
    entered(); await waiting; return { transcript: 'done', utterances: [], model: 'test' };
  } }, { leaseMs: 300, pollIntervalMs: 10 });
  const running = worker.tick(signal); await started;
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await repository.claim(300), undefined);
  finish(); await running;
  assert.equal((await database.db.select().from(listeningSegments))[0]?.status, 'transcribed');
});

test('HTTP input and DB invariants reject malformed recordings', async () => {
  assert.equal((await fetch(`${base}/api/v1/listening/segments`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/listening/segments?from=${start}`, { headers })).status, 400);
  assert.equal((await upload(randomUUID(), '')).status, 400);
  assert.equal((await fetch(`${base}/api/v1/listening/segments`, { method: 'POST', headers: {
    ...headers, 'Content-Type': 'application/json', 'X-Client-Segment-Id': randomUUID(),
    'X-Recording-Started-At': start, 'X-Recording-Ended-At': end,
  }, body: '{}' })).status, 415);
  const valid = await upload();
  await assert.rejects(database.db.update(listeningSegments).set({ endedAt: new Date(0) }).where(eq(listeningSegments.id, valid.body.id)));
  await assert.rejects(database.db.update(listeningSegments).set({ status: 'transcribed' }).where(eq(listeningSegments.id, valid.body.id)));
  await assert.rejects(database.db.execute(sql`UPDATE listening_segments SET status = 'unknown' WHERE id = ${valid.body.id}`));
});

test('all-history pagination preserves ties, dates and ownership across insertion and deletion', async () => {
  const owned = await Promise.all(Array.from({ length: 5 }, () => upload()));
  await upload(randomUUID(), 'private-bob-audio', 'bob');
  const old = owned[0]!.body.id;
  await database.db.update(listeningSegments).set({ startedAt: new Date('2026-01-01T00:00:00Z'), endedAt: new Date('2026-01-01T00:01:00Z') }).where(eq(listeningSegments.id, old));
  const get = async (query: string) => (await (await fetch(`${base}/api/v1/listening/segments?${query}`, { headers })).json()) as any;
  const first = await get('limit=2');
  assert.equal(first.segments.length, 2); assert.ok(first.nextCursor);
  const visited = first.segments.map((s: any) => s.id);
  await remove(first.segments[1].id); // A deleted cursor row remains a valid position.
  const newUpload = await upload();
  await database.db.update(listeningSegments).set({ startedAt: new Date(Date.now() - 900), endedAt: new Date(Date.now() - 100) }).where(eq(listeningSegments.id, newUpload.body.id));
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await get(`limit=2&cursor=${cursor}`);
    visited.push(...page.segments.map((s: any) => s.id)); cursor = page.nextCursor;
  }
  assert.equal(visited.length, 5); assert.equal(new Set(visited).size, 5);
  assert.deepEqual(new Set(visited), new Set(owned.map(r => r.body.id)));
  assert.equal(visited.at(-1), old);
  assert.equal((await get('limit=2')).segments[0].id, newUpload.body.id);
  for (const query of ['cursor=bad', 'cursor=', 'limit=0', 'limit=101', 'limit=2&limit=3', 'cursor=a&cursor=b', 'extra=1', `from=${start}&to=${end}&limit=2`]) {
    assert.equal((await fetch(`${base}/api/v1/listening/segments?${query}`, { headers })).status, 400, query);
  }
});

test('Echo date index counts owned legacy and batch records in the requested local day, including DST', async () => {
  const a = await upload(), b = await upload(), deleted = await upload();
  const owner = (await row(a.body.id)).userId;
  await database.db.update(listeningSegments).set({ startedAt: new Date('2026-11-01T03:30:00Z'), endedAt: new Date('2026-11-01T03:31:00Z') }).where(eq(listeningSegments.id, a.body.id));
  await database.db.update(listeningSegments).set({ startedAt: new Date('2026-11-01T06:30:00Z'), endedAt: new Date('2026-11-01T06:31:00Z') }).where(eq(listeningSegments.id, b.body.id));
  await remove(deleted.body.id); await upload(randomUUID(), 'other user', 'bob');
  await database.db.insert(listeningBatches).values({userId:owner,clientBatchId:randomUUID(),streamId:randomUUID(),sequence:1,sessionId:randomUUID(),contentHash:'test',startedAt:new Date('2026-11-01T05:30:00Z'),endedAt:new Date('2026-11-01T05:31:00Z'),segments:[],audioMilliseconds:60000});
  const index = await (await fetch(`${base}/api/v1/listening/calendar?timeZone=America%2FNew_York`, { headers })).json() as any;
  assert.deepEqual(index.days, [{date:'2026-11-01',count:2},{date:'2026-10-31',count:1}]);
  assert.equal(index.timeZone, 'America/New_York');
  const shanghai = await (await fetch(`${base}/api/v1/listening/calendar?timeZone=Asia%2FShanghai`, { headers })).json() as any;
  assert.deepEqual(shanghai.days, [{date:'2026-11-01',count:3}]);
  const timeline = await (await fetch(`${base}/api/v1/listening/timeline?timeZone=America%2FNew_York`, { headers })).json() as any;
  assert.deepEqual(timeline.days.map((d: any) => ({date:d.date,count:d.ids.length})), index.days);
  assert.equal(new Set(timeline.days.flatMap((d: any) => d.ids)).size, 3);
  assert.equal(timeline.days[0].ids[0], b.body.id);
  assert.deepEqual(timeline.days[1].ids, [a.body.id]);
  assert.ok(timeline.days.every((d: any) => Object.keys(d).sort().join(',') === 'date,ids'));
  const otherTimeline = await (await fetch(`${base}/api/v1/listening/timeline?timeZone=UTC`, { headers:{Authorization:'Bearer instant-dev-bob'} })).json() as any;
  assert.equal(otherTimeline.days.flatMap((d: any) => d.ids).length, 1);
  assert.ok(!timeline.days.flatMap((d: any) => d.ids).includes(otherTimeline.days[0].ids[0]));
  assert.equal((await fetch(`${base}/api/v1/listening/timeline?timeZone=UTC`)).status,401);
  const bob = await (await fetch(`${base}/api/v1/listening/calendar?timeZone=UTC`, { headers:{Authorization:'Bearer instant-dev-bob'} })).json() as any;
  assert.equal(bob.days.reduce((n:number,d:any)=>n+d.count,0), 1);
  assert.equal((await fetch(`${base}/api/v1/listening/calendar?timeZone=UTC`)).status,401);
  for (const query of ['', 'timeZone=bad/zone', 'timeZone=UTC&timeZone=UTC', 'timeZone=UTC&cursor=a']) {
    assert.equal((await fetch(`${base}/api/v1/listening/calendar?${query}`, { headers })).status,400,query);
    assert.equal((await fetch(`${base}/api/v1/listening/timeline?${query}`, { headers })).status,400,query);
  }
});

test('Echo seeks directly to a date and pages both ways across mixed sources without skipping ties', async () => {
  const first = await upload(), original = await row(first.body.id);
  await database.db.delete(listeningSegments);
  const ids: string[] = [];
  for (let i=0;i<85;i++) {
    const startedAt = new Date(Date.UTC(2026,0,1+Math.floor(i/5))), endedAt = new Date(startedAt.getTime()+1000), id = randomUUID();ids.push(id);
    if (i%2) await database.db.insert(listeningBatches).values({id,userId:original.userId,clientBatchId:randomUUID(),streamId:randomUUID(),sequence:1,sessionId:randomUUID(),contentHash:'test',startedAt,endedAt,segments:[],audioMilliseconds:1000});
    else await database.db.insert(listeningSegments).values({userId:original.userId,id,clientSegmentId:randomUUID(),startedAt,endedAt,mimeType:'audio/mp4',audioBytes:1,audioHash:'test',audio:Buffer.from('a')});
  }
  const get = async (params:Record<string,string>) => (await (await fetch(`${base}/api/v1/listening/segments?${new URLSearchParams(params)}`, {headers})).json()) as any;
  const jumped=await get({before:'2026-01-10T00:00:00Z',limit:'7'});
  assert.equal(jumped.segments.length,7);assert.ok(jumped.previousCursor);assert.ok(jumped.nextCursor);
  assert.ok(jumped.segments.every((s:any)=>Date.parse(s.startedAt)<Date.parse('2026-01-10T00:00:00Z')));
  const visited=jumped.segments.map((s:any)=>s.id);
  let cursor=jumped.nextCursor;
  while(cursor){const page=await get({limit:'7',cursor});visited.push(...page.segments.map((s:any)=>s.id));cursor=page.nextCursor;}
  cursor=jumped.previousCursor;
  while(cursor){const page=await get({limit:'7',cursor,direction:'newer'});visited.push(...page.segments.map((s:any)=>s.id));cursor=page.previousCursor;}
  assert.equal(visited.length,85);assert.equal(new Set(visited).size,85);assert.deepEqual(new Set(visited),new Set(ids));
  const selected=jumped.segments[0];assert.equal(typeof selected.cursor,'string');
  await remove(selected.id);
  const bob=(await upload(randomUUID(),'private','bob')).body.id;
  const refresh=await get({ids:[selected.id,jumped.segments[1].id,bob].join(',')});
  assert.deepEqual(refresh.segments.map((s:any)=>s.id),[jumped.segments[1].id]);
  for(const query of ['direction=newer','direction=wrong','before=bad','before=2026-01-10T00:00:00Z&cursor=x','ids=','ids=bad','ids='+ids.concat(ids,ids).join(','),'ids='+ids[0]+'&limit=1']){
    assert.equal((await fetch(`${base}/api/v1/listening/segments?${query}`,{headers})).status,400,query);
  }
});

test('legacy segments are archived per user on transcription and removed with the recording', async () => {
  const archive = new MemoryTranscriptArchive();
  const archived = new ListeningRepository(database.db, archive);
  const id = randomUUID();
  const uploaded = await upload(id);
  await new ListeningWorker(archived, new DevelopmentTranscriber()).tick(signal);
  const done = await row(uploaded.body.id);
  const key = transcriptKey(done.userId, id, done.startedAt);
  assert.match(archive.objects.get(key)?.transcript ?? '', /Development transcript/);
  assert.equal(archive.objects.get(key)?.kind, 'echo-segment');
  assert.equal(done.transcript, ''); assert.deepEqual(done.utterances, []);
  const listed = await archived.list(done.userId, new Date(Date.parse(start) - 1000), new Date(Date.parse(end) + 1000));
  assert.match(listed.find(x => x.id === done.id)?.transcript ?? '', /Development transcript/);
  await archived.delete(done.userId, done.id);
  assert.equal(archive.objects.has(key), false);
});


test('archive maintenance clears only the verified, still-owned transcript', async () => {
  const maintenance = new MaintenanceRepository(database.db);
  const accepted = await upload();
  await new ListeningWorker(repository, new DevelopmentTranscriber()).tick(signal);
  const verified = await row(accepted.body.id);
  assert.equal(verified.status, 'transcribed');
  await database.db.update(listeningSegments).set({ transcript: 'Changed after archive verification' }).where(eq(listeningSegments.id, verified.id));
  assert.equal(await maintenance.clearSegmentTranscript(verified), false);
  const current = await row(verified.id);
  assert.equal(await maintenance.clearSegmentTranscript({ ...current, userId: '00000000-0000-4000-8000-000000000002' }), false);
  assert.equal(await maintenance.clearSegmentTranscript(current), true);
  const cleared = await row(verified.id);
  assert.equal(cleared.transcript, '');
  assert.deepEqual(cleared.utterances, []);
  assert.equal(cleared.status, 'transcribed');
});
