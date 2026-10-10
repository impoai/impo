// Developer landing page served at the gateway root. It reuses the marketing
// site's stylesheet and mark so the paper/forest design stays in one place.

const SDK_URL = 'https://github.com/impoai/impo-gadget-sdk';
const UPSTREAM_URL = 'https://github.com/facebookincubator/muse-gadget-sdk';
const IMPO_URL = 'https://github.com/impoai/impo';

const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Impo Gadgets — Compatible with Muse Gadgets</title>
  <meta name="description" content="Connect ESP32 and Linux hardware built with the open-source Muse Gadget SDK to your Impo personal agent.">
  <link rel="icon" href="https://impo.ai/assets/favicon.ico" sizes="any">
  <link rel="icon" href="https://impo.ai/assets/instant-mark.svg" type="image/svg+xml">
  <link rel="stylesheet" href="https://impo.ai/assets/site.css">
  <style>
    .gadgets { max-width: 760px; padding-bottom: 72px; }
    .gadgets h1 { font: 400 clamp(2.25rem, 5vw + .5rem, 3.25rem)/1.1 var(--serif); margin: 0 0 20px; letter-spacing: -.01em; }
    .gadgets h1 em { color: var(--forest); }
    .gadgets h2 { font: 400 1.6rem/1.2 var(--serif); margin: 56px 0 14px; }
    .gadgets .lede { font-size: 19px; color: var(--muted); margin: 0 0 28px; }
    .gadgets .actions { display: flex; flex-wrap: wrap; gap: 12px; }
    .gadgets .panel { background: var(--paper-elevated); border: 1px solid var(--border); border-radius: 14px; padding: 6px 20px; }
    .gadgets dl { margin: 0; }
    .gadgets .row { display: grid; grid-template-columns: 9.5em 1fr; gap: 4px 16px; padding: 14px 0; }
    .gadgets .row + .row { border-top: 1px solid var(--border); }
    .gadgets dt { color: var(--muted); font-size: 15px; }
    .gadgets dd { margin: 0; min-width: 0; }
    .gadgets code { font: 15px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .gadgets .was { display: block; color: var(--muted); font-size: 14px; }
    .gadgets ul { margin: 0; padding-left: 1.2em; }
    .gadgets li { margin: 6px 0; }
    .gadgets .fine { color: var(--muted); font-size: 14px; margin-top: 56px; }
    @media (max-width: 560px) { .gadgets .row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header class="site-header">
    <div class="wrap">
      <a class="brand" href="https://impo.ai/"><img src="https://impo.ai/assets/instant-mark.svg" alt=""><span>Impo</span></a>
      <nav class="site-nav" aria-label="Main navigation">
        <a href="${SDK_URL}">Gadget SDK</a>
        <a href="${IMPO_URL}">GitHub</a>
        <a href="https://discord.gg/84ZYn3xcGV">Discord</a>
      </nav>
    </div>
  </header>

  <main class="wrap gadgets">
    <p class="eyebrow">Developer preview</p>
    <h1>Build hardware for Impo. <em>Compatible with Muse Gadgets.</em></h1>
    <p class="lede">This gateway speaks the open-source gadget link protocol used by Muse Gadgets, so ESP32 and Linux hardware built with that SDK can connect to your Impo personal agent.</p>
    <div class="actions">
      <a class="action action-primary" href="${SDK_URL}"><span>Gadget SDK for Impo</span><span aria-hidden="true">↗</span></a>
      <a class="action" href="${IMPO_URL}"><span>Impo on GitHub</span><span aria-hidden="true">↗</span></a>
    </div>

    <h2>Point a gadget at Impo</h2>
    <p>Build from <a href="${SDK_URL}">Impo's fork of the SDK</a>, which already defaults to this gateway. It is <a href="${UPSTREAM_URL}">Meta's upstream SDK</a> with these two addresses changed, Muse renamed to Impo, and its own default avatar. Upstream builds work too once you change the addresses. Gadgets accept them during setup as <code>api_url_v2</code> and <code>noise_host</code> too.</p>
    <div class="panel">
      <dl>
        <div class="row">
          <dt>Device API</dt>
          <dd><code>https://gadgets.impo.ai</code><span class="was">replaces <code>https://api.muse.ai</code></span></dd>
        </div>
        <div class="row">
          <dt>Link host</dt>
          <dd><code>gadgets.impo.ai</code><span class="was">replaces <code>hatch.metaaivm.com</code></span></dd>
        </div>
      </dl>
    </div>

    <h2>What works today</h2>
    <ul>
      <li>Verified with the Linux Device SDK: route lookup, token refresh, the encrypted session, command registration, invoke and result, gadget messages, and unpairing.</li>
      <li>Not available yet: pairing a gadget from the Impo app. Until it ships, gadgets cannot be connected to an Impo account.</li>
      <li>Not yet verified or implemented: ESP32 firmware, voice, reply streaming, and the home-network tunnel.</li>
    </ul>

    <p class="fine">Muse is a trademark of Meta Platforms, Inc. Impo is an independent source-available project and is not affiliated with or endorsed by Meta.</p>
  </main>
</body>
</html>
`;

export function homePage() {
  return new Response(page, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
