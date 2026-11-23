// Records the Drapr walkthrough: one job from website enquiry to Google review.
// Usage: TZ=Australia/Melbourne node record.js [--fast]
process.env.TZ = 'Australia/Melbourne';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { setup } = require('./harness');
const seed = require('./seed');

const FAST = process.argv.includes('--fast');
const OUT = path.join(__dirname, 'rec');
const BASE = 'http://localhost:8790/';
const wait = (ms) => new Promise((r) => setTimeout(r, FAST ? Math.min(ms, 150) : ms));

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 900 }, timezoneId: 'Australia/Melbourne', locale: 'en-AU',
    ...(FAST ? {} : { recordVideo: { dir: OUT, size: { width: 1600, height: 900 } } }),
  });
  await setup(ctx, seed);
  const page = await ctx.newPage();
  global.__page = page;
  const T0 = Date.now();
  const marks = [];
  const mark = (name) => { marks.push({ name, t: (Date.now() - T0) / 1000 }); console.log(((Date.now() - T0) / 1000).toFixed(1).padStart(6), name); };
  page.on('pageerror', (e) => console.log('PAGEERR', e.message));
  page.on('dialog', (d) => d.accept());

  await page.goto(BASE + '__studio.html');
  await page.evaluate(() => document.fonts.ready);
  const S = (fn, ...a) => page.evaluate(([f, a]) => window.studio[f](...a), [fn, a]);
  const app = () => page.frame({ name: 'app' });
  const phone = () => page.frame({ name: 'phone' });

  // ---- helpers -------------------------------------------------------------
  async function scrollTo(frame, sel, offset = 110) {
    await frame.evaluate(([s, o]) => {
      const e = typeof s === 'string' ? document.querySelector(s) : null;
      const y = e ? e.getBoundingClientRect().top + window.scrollY - o : s;
      window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
    }, [sel, offset]);
    await wait(1000);
  }
  async function scrollBy(frame, dy, ms = 1000) {
    await frame.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), dy);
    await wait(ms);
  }
  async function aim(frame, sel, { nth = 0, scroll = true, offset = 220 } = {}) {
    const loc = frame.locator(sel).nth(nth);
    await loc.waitFor({ state: 'visible', timeout: 15000 });
    if (scroll) {
      const inView = await loc.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top > 60 && r.bottom < window.innerHeight - 40; });
      if (!inView) {
        await loc.evaluate((e, o) => window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - o, behavior: 'smooth' }), offset);
        await wait(900);
      }
    }
    const b = await loc.boundingBox();
    const x = b.x + Math.min(b.width / 2, 60), y = b.y + b.height / 2;
    await S('move', x, y, 700);
    await wait(800);
    return { loc, x, y };
  }
  async function click(frame, sel, opts = {}) {
    const { loc, x, y } = await aim(frame, sel, opts);
    await S('ripple', x, y);
    await loc.click();
    await wait(opts.after ?? 700);
  }
  async function type(frame, sel, text, opts = {}) {
    const { loc } = await aim(frame, sel, opts);
    await loc.click();
    if (opts.clear !== false) await loc.fill('');
    await loc.pressSequentially(text, { delay: FAST ? 0 : 55 });
    await wait(400);
  }
  async function choose(frame, sel, value, opts = {}) {
    const { loc, x, y } = await aim(frame, sel, opts);
    await S('ripple', x, y);
    await loc.selectOption(value);
    await wait(600);
  }
  const cap = (n, t, s) => S('caption', String(n).padStart(2, '0'), t, s, null);
  const pcap = (n, k, t, s) => S('caption', String(n).padStart(2, '0'), t, s, k);
  async function loadApp() {
    await app().goto(BASE + 'index.html');
    await app().waitForSelector('#main h1', { timeout: 20000 });
    await wait(600);
  }
  async function openJob(ref, silent = false) {
    if (silent) {
      await app().locator('[data-route=jobs]').dispatchEvent('click');
      await app().waitForSelector(`text=${ref}`, { timeout: 15000 });
      await app().locator(`text=${ref}`).first().dispatchEvent('click');
    } else {
      await click(app(), '[data-route=jobs]', { scroll: false });
      await wait(500);
      await click(app(), `text=${ref}`);
    }
    await app().waitForSelector('#qb-mount .qb-totals', { timeout: 15000 });
    await wait(800);
  }
  async function openSection(mountId) {
    const open = await app().evaluate((id) => document.getElementById(id).closest('.job-section').classList.contains('open'), mountId);
    if (!open) await click(app(), `.job-section:has(#${mountId}) .sec-head`);
  }

  // ---- 0. title card -------------------------------------------------------
  await S('card', 'Every curtain, from the quote to the rehang.', 'A walk through one job in Drapr, from the website enquiry to the Google review.');
  await loadApp();                                  // load behind the card
  mark('title');
  await wait(4500);
  await cap(1, 'This is Drapr.', 'Job software for curtain and blind cleaning, built and used every day at Dr Drapes.');
  await S('hideCard'); await S('cursor', true);
  mark('dashboard');
  await wait(3500);
  await cap(1, 'The month at a glance', 'Quoted, won and invoiced against your own targets, plus win rate and pipeline.');
  await wait(4000);
  await scrollTo(app(), '#attn-chase', 140);
  await cap(1, 'Nothing slips', 'Every open quote sits on a follow-up ladder: nudge, check-in, last chance.');
  await wait(5000);

  // ---- 1. enquiry ------------------------------------------------------------
  mark('enquiry');
  await click(app(), '[data-route=enquiries]', { scroll: false });
  await cap(2, 'A customer asks for a quote', 'Your website form drops it straight into Enquiries: rooms, sizes and what they’ve noticed.');
  await wait(1500);
  await aim(app(), '.enq-card[data-enq="enq-sarah"] .enq-rooms', { scroll: false });
  await wait(4500);
  await cap(2, 'One click to a job', 'The enquiry becomes a quote with every measurement already filled in.');
  await click(app(), '[data-convert=enq-sarah]');
  await wait(900);
  await click(app(), '#ea-go', { scroll: false });
  await app().waitForSelector('#qb-mount .qb-totals', { timeout: 15000 });
  await wait(1500);

  // ---- 2. quote --------------------------------------------------------------
  mark('quote');
  await scrollTo(app(), '.qb-block-title', 90);
  await cap(3, 'Priced off your own price list', 'Drapr picks the right rate for the drop and adds mould treatment where it’s ticked.');
  await wait(2500);
  mark('priced');
  await aim(app(), '.qb-room[data-room="0"] .qb-line .line-amt', { scroll: false });
  await wait(3000);
  await type(app(), '.qb-room[data-room="0"] .qb-line .qb-note', 'Pinch pleat, lined · heavy mould on hem', { nth: 0 });
  await wait(600);
  await scrollTo(app(), '#qb-rehang', 330);
  await cap(3, 'Add the extras', 'Takedown and rehang, transport, call-out. Totals update ex and inc GST as you type.');
  await type(app(), '#qb-rehang', '145');
  await wait(1200);
  await aim(app(), '#qb-totals .grand', { scroll: true, offset: 420 });
  await wait(2500);
  await click(app(), '#qb-save');
  await wait(1000);

  // ---- 3. send ---------------------------------------------------------------
  mark('send');
  await cap(4, 'Send it in one click', 'The branded quote PDF goes by email with an Accept online button.');
  await click(app(), '#qb-email');
  await app().waitForSelector('#ce-send', { timeout: 15000 });
  await wait(4000);
  await click(app(), '#ce-send', { scroll: false });
  await wait(2500);

  // ---- 4. customer accepts on their phone -----------------------------------
  mark('accept');
  const job = await app().evaluate(() => window.__DEMO_DB.jobs.find((j) => j.quote_number === 'DRQ-2468'));
  await phone().goto(BASE + 'accept.html?t=' + job.accept_token);
  await phone().waitForSelector('#quote:not(.hidden) #q-num', { timeout: 15000, state: 'attached' }).catch(() => {});
  await pcap(5, 'The customer', 'They accept it on their phone', 'No login, no printing, no signing and scanning. The quote, the terms and one button.');
  await S('cursor', false);
  await S('mode', 'phone');
  await wait(2500);
  await scrollBy(phone(), 420, 1500); await wait(1500);
  await scrollBy(phone(), 520, 1500); await wait(1500);
  await S('cursor', true);
  mark('accept-tap');
  await click(phone(), '#go-accept');
  await wait(800);
  await type(phone(), '#a-name', 'Sarah Mitchell');
  await click(phone(), '#a-terms');
  await click(phone(), '#a-send', { after: 2000 });
  mark('accepted');
  await pcap(5, 'The customer', 'Accepted', 'They get a confirmation straight away, and so does your office.');
  await wait(3500);

  // ---- 5. back in the office --------------------------------------------------
  mark('confirmed');
  await S('cursor', false);
  await loadApp();
  await openJob('DRQ-2468', true);
  await S('mode', 'desktop');
  await S('cursor', true);
  await cap(6, 'The job confirms itself', 'Accepted online, and raised in your CRM, such as Fergus, against the right customer and site.');
  await scrollTo(app(), 0);
  await aim(app(), '.job-header .dq-big', { scroll: false });
  await wait(4500);

  // ---- 6. book the takedown --------------------------------------------------
  mark('takedown');
  await scrollTo(app(), '#td-mount', 150);
  await cap(7, 'Book the takedown where the van already is', 'Drapr reads the van’s next fortnight and suggests days it’s already nearby.');
  await wait(2000);
  await aim(app(), '#td-mount .td-card', { scroll: false }).catch(() => {});
  await wait(5500);

  // ---- 7. pre-inspection -----------------------------------------------------
  mark('pre');
  await openSection('pre-mount');
  await scrollTo(app(), '#pre-mount', 140);
  await cap(8, 'Inspect before anything comes down', 'Condition, notes, a score and photos, so nobody argues about it later.');
  await click(app(), '#pre-mount .check-item[data-group="curtains"][data-id="mould"] .chk');
  await type(app(), '#pre-mount .check-item[data-group="curtains"][data-id="mould"] .note-in', 'Spotting along lounge hems');
  await click(app(), '#pre-mount .check-item[data-group="curtains"][data-id="fading"] .chk');
  await type(app(), '#pre-mount .check-item[data-group="curtains"][data-id="fading"] .note-in', 'Linings sun-faded, north window');
  await click(app(), '#pre-mount .check-item[data-group="blinds"][data-id="heavily_stained"] .chk');
  await scrollTo(app(), '#pre-photos', 300);
  const photos = ['ph-mould.jpg', 'ph-fade.jpg', 'ph-sheer.jpg', 'ph-blind.jpg'].map((f) => path.join(__dirname, f));
  await aim(app(), '#pre-addphoto', { scroll: false });
  mark('photos');
  await app().setInputFiles('#pre-fileinput', photos);
  await wait(2500);
  await cap(8, 'Photos straight from the phone', 'They go on the inspection report the customer gets a copy of.');
  await wait(2000);
  await click(app(), '#pre-save');
  await wait(1800);

  // ---- 8. takedown and production -------------------------------------------
  mark('items');
  await loadApp(); await openJob('DRQ-2468');
  await openSection('items-mount');
  await scrollTo(app(), '#items-mount', 140);
  await cap(9, 'Every item, tracked', 'The quote becomes a list of items. The driver ticks each one off as it comes down.');
  await wait(600);
  await click(app(), '[data-ittab="takedown"]');
  mark('ticks');
  for (let i = 0; i < 4; i++) {
    await click(app(), `[data-tick="${i}"]`, { after: 500 });
  }
  await type(app(), 'input[data-f="condition"][data-i="0"]', 'Mould on hem as noted');
  await wait(1200);
  await click(app(), '[data-ittab="production"]');
  await cap(10, 'Through the plant', 'Cleaning method, bag number and rack location against every piece.');
  const methods = ['Wet clean', 'Wet clean', 'Ultrasonic', 'Ultrasonic'];
  const racks = ['Rack A', 'Rack A', 'Blind rack', 'Blind rack'];
  for (let i = 0; i < 4; i++) {
    const bag = String(1182 + (i > 1 ? 1 : 0));
    const isSel = await app().locator(`[data-f="location"][data-i="${i}"]`).evaluate((e) => e.tagName === 'SELECT');
    if (i === 0) {
      // The first piece done properly, with the pointer; the rest at working speed.
      await choose(app(), `select[data-f="method"][data-i="${i}"]`, methods[i]);
      await type(app(), `input[data-f="bag"][data-i="${i}"]`, bag);
      if (isSel) await choose(app(), `select[data-f="location"][data-i="${i}"]`, racks[i]);
      else await type(app(), `input[data-f="location"][data-i="${i}"]`, racks[i]);
      await click(app(), `[data-tick="${i}"]`, { after: 500 });
    } else {
      const row = app().locator(`[data-tick="${i}"]`);
      await row.evaluate((e) => window.scrollTo({ top: e.getBoundingClientRect().top + window.scrollY - 200, behavior: 'smooth' }));
      await wait(500);
      await app().locator(`select[data-f="method"][data-i="${i}"]`).selectOption(methods[i]);
      await app().locator(`input[data-f="bag"][data-i="${i}"]`).fill(bag);
      if (isSel) await app().locator(`select[data-f="location"][data-i="${i}"]`).selectOption(racks[i]);
      else await app().locator(`input[data-f="location"][data-i="${i}"]`).fill(racks[i]);
      await wait(300);
      await click(app(), `[data-tick="${i}"]`, { after: 350, scroll: false });
    }
  }
  await wait(1000);
  mark('rehangtab');
  await click(app(), '[data-ittab="rehang"]');
  await cap(11, 'Rehang knows where everything is', 'The rehang list and printed sheet carry each piece’s bag and rack, and no prices.');
  await wait(5000);

  // ---- 9. run sheet on the driver's phone -----------------------------------
  mark('runsheet');
  await S('cursor', false);
  await phone().goto(BASE + 'index.html');
  await phone().waitForSelector('#main h1', { timeout: 20000, state: 'attached' });
  await phone().evaluate(() => document.querySelector('[data-route=run]').click());
  await wait(2500);
  await pcap(12, 'The driver', 'The day’s run sheet', 'Tap to call, tap to navigate, and the booking notes word for word: gate codes, “call when 5 minutes away”.');
  await S('mode', 'phone');
  await wait(4000);
  await scrollBy(phone(), 380, 1500); await wait(3500);

  // ---- 10. status through to rehung, review -----------------------------------
  mark('rehung');
  await loadApp(); await openJob('DRQ-2468', true);
  await S('mode', 'desktop'); await S('cursor', true);
  await cap(13, 'Cleaned, invoiced, rehung', 'One tap moves the job on. Invoicing runs through your CRM and accounts.');
  await scrollTo(app(), 0);
  for (const st of ['in_progress', 'complete', 'invoiced']) {
    await click(app(), `.status-step[data-status="${st}"]`, { scroll: false, after: 900 });
    await app().waitForSelector(`.status-step.current[data-status="${st}"]`, { timeout: 10000 }).catch(() => {});
    await wait(600);
  }
  await click(app(), '.status-step[data-status="rehung"]', { scroll: false, after: 1500 });
  await cap(14, 'Ask for the review', 'When it’s rehung, the customer gets a thank-you with a Google review button.');
  await app().waitForSelector('#rv-send', { timeout: 10000 }).catch(() => {});
  mark('review');
  await wait(4500);
  await click(app(), '#rv-send', { scroll: false, after: 2000 });

  // ---- 11. reports -----------------------------------------------------------
  mark('reports');
  await click(app(), '[data-route=reports]', { scroll: false });
  await cap(15, 'And the numbers behind it', 'Reports for any period and any account, to PDF or CSV, with a weekly report by email.');
  await wait(3000);
  await scrollBy(app(), 420, 1500); await wait(3500);

  // ---- end card ----------------------------------------------------------------
  mark('end');
  await S('cursor', false);
  await S('card', 'Built by curtain cleaners, for curtain cleaners.', 'Drapr runs every job at Dr Drapes Curtain Clinic, Melbourne.', 'quote.drdrapes.com.au/drapr');
  await wait(6000);
  mark('done');

  fs.writeFileSync(path.join(OUT, 'marks.json'), JSON.stringify(marks, null, 1));
  await page.close();
  await ctx.close();
  await browser.close();
})().catch(async (e) => { console.error(e.message.split('\n')[0]); try { await global.__page.screenshot({ path: __dirname + '/fail.png' }); const f = global.__page.frame({ name: 'app' }); console.log(await f.evaluate(() => document.querySelector('#main').innerText.slice(0, 800))); } catch (_) {} process.exit(1); });
