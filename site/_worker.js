import downloads from '../server/downloads/worker.mjs';

// Pages owns this hostname. Keep the website's asset serving untouched outside
// the three download routes; Wrangler bundles the shared module on deployment.
export default {
  fetch(request, env, context) {
    const path = new URL(request.url).pathname;
    if (path === '/android.apk' || path === '/android/latest.json' ||
        /^\/android\/releases\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}-[1-9][0-9]*\/impo\.apk$/.test(path)) {
      return downloads.fetch(request, env, context);
    }
    return env.ASSETS.fetch(request);
  },
};
