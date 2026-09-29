// Reproducible, synthetic Echo UI dataset. Never connects to a remote database.
// Run: node --env-file=.env scripts/echo-ui-fixture.mjs
import pg from 'pg';
import {execFileSync,spawn} from 'node:child_process';
import net from 'node:net';

if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL for the local PostgreSQL instance');
const url=new URL(process.env.DATABASE_URL);
if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Echo fixtures require local PostgreSQL');
const probe=net.createServer();
await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(3009,'127.0.0.1',resolve);});
await new Promise(resolve=>probe.close(resolve));
const name='instant_echo_qa',admin=new pg.Pool({connectionString:url.toString()});
try {
 if(!(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount) await admin.query('CREATE DATABASE '+name);
} finally { await admin.end(); }
url.pathname='/'+name;
const env={...process.env,DATABASE_URL:url.toString(),INSTANT_AUTH_MODE:'local-dev',INSTANT_RUNTIME:'development',NODE_ENV:'development',PORT:'3009'};
execFileSync('npm',['run','db:push'],{env,stdio:'inherit'});
execFileSync('npm',['run','db:seed'],{env,stdio:'inherit'});
const pool=new pg.Pool({connectionString:url.toString()});
try {
 const {rows:[user]}=await pool.query("select id from users where auth_subject='alice'");
 if(!user) throw new Error('Missing QA account');
 await pool.query('delete from listening_segments where user_id=$1',[user.id]);
 await pool.query('delete from listening_batches where user_id=$1',[user.id]);
await pool.query(`INSERT INTO listening_batches (id,user_id,client_batch_id,stream_id,sequence,session_id,content_hash,started_at,ended_at,audio_milliseconds,segments,status,transcript,model)
SELECT md5('echo-qa-'||i)::uuid,$1,md5('echo-qa-batch-'||i)::uuid,md5('echo-qa-stream-'||i)::uuid,1,md5('echo-qa-session-'||i)::uuid,'qa-fixture',
 '2026-09-27T20:00:00Z'::timestamptz - (i/40)*interval '1 day' - (i%40)*interval '90 seconds',
 '2026-09-27T20:00:30Z'::timestamptz - (i/40)*interval '1 day' - (i%40)*interval '90 seconds',30000,'[]'::jsonb,'transcribed',
 CASE i%5 WHEN 0 THEN 'Let’s leave a little room this afternoon. We could take the long way home and stop for coffee.'
 WHEN 1 THEN 'The idea for tomorrow: start with the smallest useful version, then ask what we actually learned.'
 WHEN 2 THEN 'Remember the quiet bookshop near the station? I’d like to go back there this weekend.'
 WHEN 3 THEN 'We talked about taking a few days by the sea. Nothing rushed, just walking and reading.'
 ELSE 'I think the presentation works better if we start with the story, then show the numbers.' END || ' [QA ' || lpad(i::text,5,'0') || ']','qa-fixture'
FROM generate_series(0,19999) i`,[user.id]);
 const {rows:[recording]}=await pool.query("SELECT id, started_at, ended_at FROM listening_batches WHERE user_id=$1 ORDER BY started_at DESC LIMIT 1",[user.id]);
 const started=recording.started_at.toISOString(),ended=recording.ended_at.toISOString(),middle=new Date(recording.started_at.getTime()+15000).toISOString();
 const locations=[{from:started,to:middle,capturedAt:started,accuracyMeters:80,source:'device',granularity:'district',city:'Shanghai',country:'China',district:"Jing'an"},
   {from:middle,to:ended,capturedAt:middle,accuracyMeters:90,source:'device',granularity:'district',city:'Shanghai',country:'China',district:'Huangpu'}];
 await pool.query('UPDATE listening_batches SET segments=$1 WHERE id=$2',[JSON.stringify([{segmentId:recording.id,startedAt:started,endedAt:ended,locations}]),recording.id]);
 console.log('Echo fixture: 20,000 synthetic records across 500 days; local API :3009. Ctrl-C stops the API.');
} finally { await pool.end(); }
const api=spawn(process.execPath,['--import','tsx','server/src/api-main.ts'],{env,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>api.kill(signal));
api.on('exit',(code,signal)=>{process.exitCode=signal?0:code??1;});
