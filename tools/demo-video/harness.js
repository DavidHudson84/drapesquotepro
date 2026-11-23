// Shared Playwright setup: serves the real app with the fake backend.
const path = require('path');
const fs = require('fs');
const D = __dirname;
async function setup(context, seed, { fresh = true } = {}) {
  await context.addInitScript(({ seed, fresh }) => {
    window.__DEMO_SEED = seed;
  }, { seed, fresh });
  await context.route(/esm\.sh\/@supabase\/supabase-js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(D, 'fake-supabase.js'), 'utf8') }));
  await context.route(/esm\.sh\/jspdf/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(D, 'dist/jspdf.js'), 'utf8') }));
  await context.route(/esm\.sh\/chart\.js/, (r) => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(D, 'dist/chart.js'), 'utf8') }));
  await context.route(/supabase\.co\/functions\/v1\/([a-z-]+)/, async (r) => {
    const fn = r.request().url().match(/functions\/v1\/([a-z-]+)/)[1];
    const { handlers } = require('./fns');
    const h = handlers[fn];
    let body = { ok: true };
    try { body = h ? await h(r.request(), r.request().frame()) : { ok: true }; } catch (e) { console.log('FN ERR', fn, e.message); }
    await new Promise((res) => setTimeout(res, 400));
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) });
  });
  await context.route(/\/__studio\.html/, (r) => r.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(D, 'studio.html'), 'utf8') }));
  await context.route(/supabase\.co\/(rest|auth|storage)\//, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
}
module.exports = { setup };
