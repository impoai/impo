// Local-only network fault fixture for Echo UI tests. Start echo-ui-fixture.mjs first.
import { createServer } from 'node:http';
let delayMs = 0, failures = 0, bodies = [];
createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1:3010');
    if (url.pathname === '/__echo-fixture') {
      if (req.method === 'POST') {
        let input = ''; for await (const part of req) input += part;
        const settings = JSON.parse(input);
        delayMs = Math.min(10000, Math.max(0, settings.delayMs ?? 0));
        failures = Math.max(0, settings.failures ?? 0); bodies = [];
      }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({bodies})); return;
    }
    if (url.pathname === '/api/v1/listening/segments' && url.searchParams.has('ids')) {
      bodies.push(url.searchParams.get('ids').split(','));
      const fail = failures > 0; if (fail) failures--;
      await new Promise(resolve => setTimeout(resolve, delayMs));
      if (fail) { res.writeHead(503, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:{code:'fixture_offline',message:'Synthetic offline response',retryable:true}})); return; }
    }
    const upstream = await fetch(`http://127.0.0.1:3009${req.url}`, {headers:{Authorization:req.headers.authorization ?? ''}});
    res.writeHead(upstream.status, {'Content-Type':upstream.headers.get('content-type') ?? 'application/json'});
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch { res.writeHead(502); res.end(); }
}).listen(3010, '127.0.0.1', () => console.log('Local Echo fault fixture: :3010 → :3009'));
