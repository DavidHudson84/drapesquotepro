// partner-portal
//
// Everything a trade partner can do, and the only door they have. Partner
// logins are not app_users, so every RLS policy in the database returns
// nothing to them; this function runs as service role and scopes every read
// and write to the partner's own account.
//
// Three kinds of caller:
//
//   PARTNER (Authorization: Bearer <partner session>)
//     me, save_profile, list_jobs, get_job, price, save_quote, save_inspection, photo_url,
//     email_quote, customer_accepted, customer_declined
//
//   STAFF ADMIN (Authorization: Bearer <staff session>, role admin)
//     create_partner { business_name, email, contact_name?, referral_pct?, install_pct? }
//                   — makes (or switches on) the account and sends the welcome email
//     invite        { account_id, name, email, phone? }  — another login, or a re-send
//     set_active    { partner_user_id, active }
//
//   PUBLIC (no session)
//     redeem_invite { token }   -> a one-shot GoTrue token the page redeems
//     forgot        { email }   -> emails a fresh set-password link
//
//   SYSTEM (x-report-secret, from the database)
//     notify_status { job_id, new_status }   — the jobs status trigger
//     statements    { dry_run?, month? }      — monthly commission statements
//
// PRICES. Partners can't change a price. The page sends measurements; this
// function prices them against the live price list and stores the result, so
// whatever the browser shows, the job holds our numbers. The engine below is
// a copy of computeLine / computeRepair / computeQuote in index.html — if the
// pricing there changes, change it here in the same commit.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FROM = 'Dr Drapes Curtain Clinic <send@quotes.drdrapes.com.au>';
const OFFICE = 'drdrapes@hudsongroup.com.au';
// Partner admin (new quotes, set-ups, commission, partner questions) goes to
// whoever runs the partner program; the office gets the job work. Override
// with the 'partner-manager-email' setting.
const MANAGER_DEFAULT = 'david@hudsongroup.com.au';
const managerOf = (settings: Record<string, string>) =>
  String(settings?.['partner-manager-email'] || '').trim() || MANAGER_DEFAULT;
const PORTAL_BASE_DEFAULT = 'https://davidhudson84.github.io/drapesquotepro/';
const INVITE_DAYS = 7;
const RESET_HOURS = 24;
const MAX_PHOTOS = 8;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-report-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };

// ============================================================ pricing engine
// Mirrors index.html. Keep in step.

const CATALOG: Record<string, { label: string; mode: string; key?: string }> = {
  curtain: { label: 'Standard Curtain / Drape', mode: 'curtain' },
  sheer: { label: 'Sheer Curtain', mode: 'sheer' },
  velvet: { label: 'Velvet / Silk / Linen / Satin', mode: 'velvet' },
  roman: { label: 'Roman Blind', mode: 'blind', key: 'roman' },
  austrian: { label: 'Austrian Blind', mode: 'blind', key: 'austrian' },
  'roller-sun': { label: 'Roller Blind — Sunscreen', mode: 'blind', key: 'roller-sun' },
  'roller-block': { label: 'Roller Blind — Blockout', mode: 'blind', key: 'roller-block' },
  venetian: { label: 'Venetian Blind', mode: 'blind', key: 'venetian' },
  pelmet: { label: 'Pelmet', mode: 'flatw', key: 'pelmet' },
  swags: { label: 'Swags & Tails', mode: 'flatw', key: 'swags' },
  valance: { label: 'Valance on Hooks', mode: 'flatw', key: 'valance' },
};

const REPAIRS: [string, string][] = [
  ['cord-replace', 'Cord Replace'], ['cord-tidy', 'Cord Tidy'],
  ['hook-replace', 'Hook Replace'], ['ring-replace', 'Ring Replace'],
  ['weight-replace', 'Weight Replace'], ['track-repair', 'Track Repair'],
  ['track-replace', 'Track Replace'], ['motor-service', 'Motor Service'],
  ['motor-replace', 'Motor Replace'], ['lining-repair', 'Lining Repair'],
  ['heading-repair', 'Heading Repair'], ['seam-repair', 'Seam Repair'],
  ['bracket-replace', 'Bracket Replace'], ['wand-replace', 'Wand Replace'],
  ['fascia-repair', 'Fascia Repair'],
];
const REPAIR_KEYS = new Set(REPAIRS.map(([k]) => k));

// Every settings key the engine can read. Sent to the partner page so it can
// show a rate next to a line; never anything else from settings.
const RATE_KEYS = [
  'curtain-s', 'curtain-m', 'curtain-l', 'sheer-s', 'sheer-l', 'velvet-s', 'velvet-m', 'velvet-l',
  'roman', 'austrian', 'venetian', 'roller-sun', 'roller-block', 'pelmet', 'swags', 'valance',
  'mould', 'mould-blind', ...REPAIRS.map(([k]) => k),
];

const round2 = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;

function toMetres(raw: unknown) {
  const n = parseFloat(String(raw ?? ''));
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 100 ? n / 1000 : n;
}
const curtainTier = (d: number) => d > 3.8 ? 'curtain-l' : d > 2.4 ? 'curtain-m' : 'curtain-s';
const velvetTier = (d: number) => d > 3.8 ? 'velvet-l' : d > 2.4 ? 'velvet-m' : 'velvet-s';
const sheerTier = (d: number) => d > 3.0 ? 'sheer-l' : 'sheer-s';

type Rates = Record<string, number>;

function computeLine(rates: Rates, line: any) {
  const cat = CATALOG[line.cat];
  if (!cat) return { amount: 0, rateUsed: 0, widthM: 0, dropM: 0, sqm: 0, mouldAmt: 0 };
  const r = (k: string) => Number(rates[k] || 0);
  const widthM = toMetres(line.width), dropM = toMetres(line.drop);
  const ov = line.rate_override !== undefined && line.rate_override !== '' && line.rate_override !== null;
  const pick = (k: string) => ov ? Number(line.rate_override) : r(k);
  let base = 0, rateUsed = 0, sqm = 0, mouldAmt = 0;
  if (cat.mode === 'curtain' || cat.mode === 'sheer' || cat.mode === 'velvet') {
    rateUsed = pick(cat.mode === 'curtain' ? curtainTier(dropM) : cat.mode === 'velvet' ? velvetTier(dropM) : sheerTier(dropM));
    base = rateUsed * widthM;
    if (line.mould) mouldAmt = r('mould') * widthM;
  } else if (cat.mode === 'blind') {
    rateUsed = pick(cat.key!);
    sqm = widthM * dropM;
    base = rateUsed * sqm;
    if (line.mould) mouldAmt = r('mould-blind') * sqm;
  } else if (cat.mode === 'flatw') {
    rateUsed = pick(cat.key!);
    base = rateUsed * widthM;
    if (line.mould) mouldAmt = r('mould') * widthM;
  }
  return { amount: round2(base + mouldAmt), rateUsed, widthM, dropM, sqm: round2(sqm), mouldAmt: round2(mouldAmt) };
}

function computeRepair(rates: Rates, rep: any) {
  const qty = Math.max(0, parseInt(rep.qty, 10) || 0);
  const ov = rep.rate_override !== undefined && rep.rate_override !== '' && rep.rate_override !== null;
  const rateUsed = ov ? Number(rep.rate_override) : Number(rates[rep.key] || 0);
  return { amount: round2(qty * rateUsed), qty, rateUsed };
}

// Same roll-up as computeQuote() in index.html, plus the commission base:
// cleaning and repair lines only, after any discount the office applies.
function computeQuote(rates: Rates, q: any) {
  let lines = 0;
  (q.rooms || []).forEach((room: any) => {
    (room.items || []).forEach((l: any) => {
      // A custom line priced by the office is honoured as it stands.
      lines += l.cat === 'custom' ? round2(l.amount) : computeLine(rates, l).amount;
    });
    (room.repairs || []).forEach((rp: any) => { lines += computeRepair(rates, rp).amount; });
  });
  (q.repairs || []).forEach((rp: any) => { lines += computeRepair(rates, rp).amount; });
  let sub = lines;
  const ex = q.extras || {};
  ['fuel_amt', 'transport', 'rehang', 'callout', 'storage', 'other_amt'].forEach((k) => {
    if (k === 'fuel_amt' && !ex.fuel_on) return;
    sub += Number(ex[k]) || 0;
  });
  let disc = 0;
  const d = q.discount || { type: 'none', value: 0 };
  if (d.type === 'percent') disc = sub * (Number(d.value) || 0) / 100;
  else if (d.type === 'fixed') disc = Number(d.value) || 0;
  const subtotal = round2(sub - disc);
  const gst = round2(subtotal * 0.1);
  const total = round2(subtotal + gst);
  // A discount comes off the whole quote, so it comes off the commission base
  // in proportion — the partner shares the discount, not just us.
  const share = sub > 0 ? Math.max(0, (sub - disc) / sub) : 0;
  const commissionBase = round2(lines * share);
  return { subtotal, gst, total, discountAmt: round2(disc), preDiscount: round2(sub), commissionBase };
}

const commissionOf = (base: number, pct: unknown) => round2(base * (Number(pct) || 0) / 100);

// Takes whatever the page sent and keeps only what a partner may set. No rate
// overrides, no custom lines, no extras, no discount: the price list is the
// price. Measurements are clipped to sane strings.
function cleanQuoteInput(input: any) {
  const s = (v: unknown, n = 200) => String(v ?? '').slice(0, n);
  const num = (v: unknown) => s(v, 12).replace(/[^0-9.]/g, '');
  const rooms = (Array.isArray(input?.rooms) ? input.rooms : []).slice(0, 40).map((r: any, ri: number) => ({
    name: s(r?.name, 80).trim() || `Room ${ri + 1}`,
    items: (Array.isArray(r?.items) ? r.items : []).slice(0, 60)
      .filter((it: any) => CATALOG[it?.cat])
      .map((it: any) => ({
        cat: it.cat, width: num(it.width), drop: num(it.drop),
        mould: !!it.mould, item_note: s(it.item_note, 200),
      })),
    repairs: (Array.isArray(r?.repairs) ? r.repairs : []).slice(0, 30)
      .filter((rp: any) => REPAIR_KEYS.has(rp?.key))
      .map((rp: any) => ({ key: rp.key, qty: String(Math.min(999, Math.max(0, parseInt(rp.qty, 10) || 0))) })),
  }));
  return {
    rooms,
    repairs: [],
    notes: s(input?.notes, 2000),
    insurer_name: s(input?.insurer_name, 120),
    claim_number: s(input?.claim_number, 60),
  };
}

// Build the stored quote object exactly as the staff quote builder saves it,
// so the job opens in Drapr's quote builder as if it had been raised there.
function buildQuote(rates: Rates, account: any, clean: any, installBy: string, existing: any = {}) {
  const extras = { fuel_on: false, fuel_amt: '', transport: '', rehang: '', callout: '', storage: '', other_amt: '', other_desc: '' };
  if (Number(account.partner_transport_fee) > 0) extras.transport = String(account.partner_transport_fee);
  if (installBy === 'drdrapes' && Number(account.partner_rehang_fee) > 0) extras.rehang = String(account.partner_rehang_fee);
  const q: any = {
    ...existing,
    type: 'fast_quote',
    rooms: clean.rooms,
    repairs: clean.repairs,
    extras,
    discount: { type: 'none', value: '' },
    insurer_name: clean.insurer_name,
    claim_number: clean.claim_number,
    notes: clean.notes,
    show_rates: true,
  };
  const t = computeQuote(rates, q);
  q.subtotal = t.subtotal; q.gst = t.gst; q.total = t.total;
  return { q, t };
}

// Lines with their computed amounts, for the page and for the PDF it builds.
function pricedView(rates: Rates, q: any) {
  return {
    ...q,
    rooms: (q.rooms || []).map((room: any) => ({
      ...room,
      items: (room.items || []).map((it: any) => {
        if (it.cat === 'custom') return { ...it, label: it.label || 'Custom item', amount: round2(it.amount), calc: null };
        const c = computeLine(rates, it);
        return { ...it, label: CATALOG[it.cat]?.label || it.cat, amount: c.amount, calc: c };
      }),
      repairs: (room.repairs || []).map((rp: any) => {
        const c = computeRepair(rates, rp);
        return { ...rp, label: (REPAIRS.find(([k]) => k === rp.key) || [, rp.key])[1], amount: c.amount, calc: c };
      }),
    })),
    repairs: (q.repairs || []).map((rp: any) => {
      const c = computeRepair(rates, rp);
      return { ...rp, label: (REPAIRS.find(([k]) => k === rp.key) || [, rp.key])[1], amount: c.amount, calc: c };
    }),
  };
}

// ================================================================== helpers

const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!
));
const money = (n: unknown) => '$' + Number(n || 0).toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const firstName = (n: unknown) => String(n ?? '').trim().split(/\s+/)[0] || '';
const validEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const STATUS_LABEL: Record<string, string> = {
  quoted: 'Quoted', confirmed: 'Confirmed', in_progress: 'In progress',
  complete: 'Cleaned & ready', invoiced: 'Invoiced', rehung: 'Rehung / completed', declined: 'Declined',
};
const DECLINE_REASONS = ['price', 'elsewhere', 'timing', 'no_response', 'other'];

async function sendEmail(opts: { to: string[]; cc?: string[]; replyTo?: string | string[]; subject: string; html: string; attachments?: any[] }) {
  const key = Deno.env.get('RESEND_API_KEY');
  const to = opts.to.filter(Boolean);
  if (!key || !to.length) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to, cc: (opts.cc || []).filter(Boolean),
      reply_to: opts.replyTo || OFFICE, subject: opts.subject, html: opts.html,
      ...(opts.attachments ? { attachments: opts.attachments } : {}),
    }),
  });
  if (!res.ok) console.error('Resend failed', await res.text());
  return res.ok;
}

const shell = (inner: string, sub = '') => `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Arial,Helvetica,sans-serif;margin:0;background:#f1f4f3">
<div style="max-width:600px;margin:20px auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #e2e8e7">
  <div style="background:#323264;padding:22px 28px">
    <div style="font-size:19px;font-weight:700;color:#fff">Dr Drapes Curtain Clinic</div>
    ${sub ? `<div style="font-size:12px;color:rgba(255,255,255,.7);margin-top:4px">${escapeHtml(sub)}</div>` : ''}
  </div>
  <div style="padding:26px 28px">${inner}</div>
</div></body></html>`;

const button = (href: string, label: string) => `
  <div style="margin:22px 0;text-align:center">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:#C81B55;color:#fff;padding:13px 28px;border-radius:8px;text-decoration:none;font-weight:700;font-size:14px">${escapeHtml(label)}</a>
  </div>`;

const table = (rows: [string, string][]) => `
  <table style="width:100%;border-collapse:collapse;background:#f7f7fb;border:1px solid #e4e4ee;border-radius:6px">
    ${rows.filter(([, v]) => v).map(([k, v]) => `<tr>
      <td style="padding:8px 12px;color:#777;font-size:12px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td>
      <td style="padding:8px 12px;color:#222;font-size:14px">${escapeHtml(v)}</td></tr>`).join('')}
  </table>`;

function paras(text: unknown) {
  return String(text ?? '').replace(/\r\n/g, '\n').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px;color:#333;font-size:14px;line-height:1.5">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
}

// ==================================================================== main

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'Body must be JSON' }, 400); }
  const action = String(body?.action ?? '');

  try {
    // ---------------------------------------------------------- system
    if (action === 'notify_status' || action === 'statements') {
      await requireSecret(admin, req);
      if (action === 'notify_status') return json(await notifyStatus(admin, body));
      return json(await statements(admin, body));
    }
    // Setting a partner up from the database or a script (no staff login to
    // hand), e.g. select net.http_post(...) with the report secret.
    if (action === 'create_partner' && req.headers.get('x-report-secret')) {
      await requireSecret(admin, req);
      const { data: co } = await admin.from('companies').select('id').order('created_at').limit(1).single();
      return json(await createPartner(admin, { company_id: body?.company_id || co.id }, body));
    }

    // ---------------------------------------------------------- public
    if (action === 'redeem_invite') return json(await redeemInvite(admin, body));
    if (action === 'forgot') { await forgot(admin, body); return json({ ok: true }); }

    // ------------------------------------------------- authenticated
    const authHeader = req.headers.get('Authorization') ?? '';
    const jwt = authHeader.replace(/^Bearer\s+/i, '');
    if (!jwt) fail(401, 'Not signed in');
    const { data: { user }, error: uErr } = await admin.auth.getUser(jwt);
    if (uErr || !user) fail(401, 'Not signed in');

    if (action === 'invite' || action === 'set_active' || action === 'create_partner') {
      const staff = await requireStaffAdmin(admin, user!.id);
      if (action === 'create_partner') return json(await createPartner(admin, staff, body));
      if (action === 'invite') return json(await invite(admin, staff, body));
      return json(await setActive(admin, staff, body));
    }

    const ctx = await partnerContext(admin, user!.id);
    switch (action) {
      case 'me': return json(await me(admin, ctx));
      case 'save_profile': return json(await saveProfile(admin, ctx, body));
      case 'list_jobs': return json(await listJobs(admin, ctx));
      case 'get_job': return json(await getJob(admin, ctx, body));
      case 'price': return json(price(ctx, body));
      case 'save_quote': return json(await saveQuote(admin, ctx, body));
      case 'save_inspection': return json(await saveInspection(admin, ctx, body));
      case 'photo_url': return json(await photoUrl(admin, ctx, body));
      case 'email_quote': return json(await emailQuote(admin, ctx, body));
      case 'customer_accepted': return json(await customerAccepted(admin, ctx, body));
      case 'customer_declined': return json(await customerDeclined(admin, ctx, body));
      default: fail(400, 'Unknown action');
    }
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error('partner-portal error', e);
    return json({ error: 'Something went wrong. Try again, or call the office on 1300 652 866.' }, 500);
  }
  return json({ error: 'Unknown action' }, 400);
});

// ================================================================ contexts

async function requireSecret(admin: any, req: Request) {
  const given = req.headers.get('x-report-secret') || '';
  const { data } = await admin.from('integration_secrets').select('value').eq('key', 'report-trigger-secret').maybeSingle();
  if (!data?.value || given !== data.value) fail(401, 'Bad secret');
}

async function requireStaffAdmin(admin: any, userId: string) {
  const { data: p } = await admin.from('app_users').select('id, company_id, name, role, active').eq('id', userId).maybeSingle();
  if (!p || p.active === false) fail(403, 'Staff only');
  if (p.role !== 'admin') fail(403, 'Only an admin can manage partner logins');
  return p;
}

async function loadSettings(admin: any, companyId: string) {
  const { data } = await admin.from('settings').select('key, value').eq('company_id', companyId);
  const s: Record<string, string> = {};
  (data || []).forEach((r: any) => { s[r.key] = r.value; });
  return s;
}

const portalBase = (settings: Record<string, string>) => {
  const v = String(settings['portal-base-url'] || '').trim() || PORTAL_BASE_DEFAULT;
  return v.endsWith('/') ? v : v + '/';
};

type Ctx = { user: any; account: any; settings: Record<string, string>; rates: Rates; company: any };

async function partnerContext(admin: any, userId: string): Promise<Ctx> {
  const { data: user } = await admin.from('partner_users').select('*').eq('id', userId).maybeSingle();
  if (!user || !user.active) fail(403, 'This login is not active. Call Dr Drapes on 1300 652 866.');
  const { data: account } = await admin.from('accounts').select('*').eq('id', user.account_id).single();
  if (!account || !account.is_partner || account.active === false) fail(403, 'Partner access is switched off for your business. Call Dr Drapes on 1300 652 866.');
  const [settings, { data: company }] = await Promise.all([
    loadSettings(admin, user.company_id),
    admin.from('companies').select('id, name, contact_email, contact_phone').eq('id', user.company_id).single(),
  ]);
  const rates: Rates = {};
  RATE_KEYS.forEach((k) => { rates[k] = Number(settings[k] || 0); });
  return { user, account, settings, rates, company };
}

async function ownJob(admin: any, ctx: Ctx, jobId: unknown) {
  const id = String(jobId ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) fail(400, 'Bad job id');
  const { data: job } = await admin.from('jobs').select('*').eq('id', id).maybeSingle();
  if (!job || job.partner_account_id !== ctx.account.id || job.archived) fail(404, 'Job not found');
  return job;
}

const commissionPctFor = (account: any, installBy: string) =>
  Number(installBy === 'partner' ? account.commission_install_pct : account.commission_referral_pct) || 0;

const officeRecipients = (ctx: { company: any }) => [...new Set([ctx.company?.contact_email, OFFICE].filter(Boolean))] as string[];

// ================================================================= partner

async function me(admin: any, ctx: Ctx) {
  await admin.from('partner_users').update({ last_login: new Date().toISOString() }).eq('id', ctx.user.id);
  const a = ctx.account;
  return {
    ok: true,
    user: { name: ctx.user.name, email: ctx.user.email, phone: ctx.user.phone || '' },
    account: {
      name: a.name, phone: a.phone, email: a.email,
      address_line: a.address_line || '', suburb: a.suburb || '', state: a.state || 'VIC', postcode: a.postcode || '',
      abn: a.abn || '', website: a.website || '', gst_registered: a.gst_registered,
      logo: a.partner_logo || null,
      onboarded: !!a.partner_onboarded_at,
      commission_referral_pct: Number(a.commission_referral_pct),
      commission_install_pct: Number(a.commission_install_pct),
      invoice_default: a.partner_invoice_default,
      rehang_fee: a.partner_rehang_fee != null ? Number(a.partner_rehang_fee) : null,
      transport_fee: a.partner_transport_fee != null ? Number(a.partner_transport_fee) : null,
      reference_label: a.reference_label || 'Your reference',
    },
    rates: ctx.rates,
    catalog: Object.fromEntries(Object.entries(CATALOG).map(([k, v]) => [k, { label: v.label, mode: v.mode }])),
    repairs: REPAIRS,
    // The quote PDF carries our intro, outro and terms exactly as the staff
    // app prints them.
    pdf: {
      intro: ctx.settings['email-intro'] || '',
      outro: ctx.settings['email-outro'] || '',
      terms: ctx.settings['terms-text'] || '',
    },
  };
}

async function listJobs(admin: any, ctx: Ctx) {
  const { data } = await admin.from('jobs')
    .select('id, quote_number, customer_name, site_address, status, created_at, updated_at, commission_pct, account_reference, data')
    .eq('partner_account_id', ctx.account.id)
    .eq('archived', false)
    .order('created_at', { ascending: false })
    .limit(300);
  return {
    ok: true,
    jobs: (data || []).map((j: any) => {
      return {
        id: j.id, quote_number: j.quote_number, customer_name: j.customer_name, site_address: j.site_address,
        status: j.status, created_at: j.created_at, updated_at: j.updated_at, reference: j.account_reference,
        total: Number(j.data?.quote?.total || 0),
        commission: commissionOf(storedBase(j, ctx.rates), j.commission_pct),
        created_by: j.data?.partner?.submitted_by_name || '',
        sent_at: j.data?.quote?.sent_at || null,
        has_pre_inspection: !!j.data?.pre_inspection?.saved_at,
      };
    }),
  };
}

// The commission base as it stands on the job: stamped whenever the quote is
// saved, here or in Drapr's quote builder, so it always follows the price the
// customer is actually charged, office edits included.
function storedBase(job: any, liveRates: Rates) {
  const b = job.data?.partner?.commission_base;
  return b != null ? Number(b) : computeQuote(liveRates, job.data?.quote || {}).commissionBase;
}

async function getJob(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  const rates = ctx.rates;
  const q = job.data?.quote || {};
  const t = computeQuote(rates, q);
  const base = storedBase(job, rates);
  const pre = job.data?.pre_inspection || null;
  return {
    ok: true,
    job: {
      id: job.id, quote_number: job.quote_number, status: job.status,
      customer_name: job.customer_name, customer_phone: job.customer_phone, customer_email: job.customer_email,
      site_address: job.site_address, reference: job.account_reference,
      created_at: job.created_at,
      quote: pricedView(rates, q),
      totals: t,
      commission_pct: Number(job.commission_pct || 0),
      commission: commissionOf(base, job.commission_pct),
      commission_paid_at: job.commission_paid_at,
      partner: {
        invoice_to: job.data?.partner?.invoice_to || 'drdrapes',
        install_by: job.data?.partner?.install_by || 'drdrapes',
        submitted_by_name: job.data?.partner?.submitted_by_name || '',
      },
      editable: job.status === 'quoted' && !job.data?.acceptance?.confirmed_at,
      sent: { at: q.sent_at || null, to: q.sent_to || null },
      declined: job.data?.declined ? { reason: job.data.declined.reason, at: job.data.declined.at } : null,
      timeline: (job.data?.status_history || []).map((h: any) => ({ status: h.status, at: h.changed_at })),
      pre_inspection: pre ? {
        date: pre.date, inspector: pre.inspector, saved_at: pre.saved_at,
        curt_checks: pre.curt_checks || [], blind_checks: pre.blind_checks || [], hw_checks: pre.hw_checks || [],
        curt_na: !!pre.curt_na, blind_na: !!pre.blind_na,
        curt_score: pre.curt_score ?? 5, blind_score: pre.blind_score ?? 5,
        cust_notes: pre.cust_notes || '', job_notes: pre.partner_notes || '',
        photos: (pre.photos || []).map((p: any) => ({ path: p.path, name: p.name })),
      } : null,
    },
  };
}

function price(ctx: Ctx, body: any) {
  const installBy = body?.install_by === 'partner' ? 'partner' : 'drdrapes';
  const clean = cleanQuoteInput(body?.quote);
  const { q, t } = buildQuote(ctx.rates, ctx.account, clean, installBy);
  const pct = commissionPctFor(ctx.account, installBy);
  return { ok: true, quote: pricedView(ctx.rates, q), totals: t, commission_pct: pct, commission: commissionOf(t.commissionBase, pct) };
}

async function saveQuote(admin: any, ctx: Ctx, body: any) {
  const c = body?.customer || {};
  const name = String(c.name ?? '').trim().slice(0, 120);
  if (name.length < 2) fail(400, 'Customer name is needed');
  const email = String(c.email ?? '').trim().toLowerCase().slice(0, 160);
  if (email && !validEmail(email)) fail(400, 'That customer email doesn\'t look right');
  const phone = String(c.phone ?? '').trim().slice(0, 40);
  const address = String(c.address ?? '').trim().slice(0, 240);
  const reference = String(body?.reference ?? '').trim().slice(0, 60) || null;
  const installBy = body?.install_by === 'partner' ? 'partner' : 'drdrapes';
  const invoiceTo = body?.invoice_to === 'partner' ? 'partner' : 'drdrapes';

  const clean = cleanQuoteInput(body?.quote);
  const itemCount = clean.rooms.reduce((n: number, r: any) => n + r.items.length + r.repairs.length, 0);
  if (!itemCount) fail(400, 'Add at least one item to the quote');

  const now = new Date().toISOString();
  const pct = commissionPctFor(ctx.account, installBy);
  const who = `${ctx.user.name} (partner)`;

  if (body?.job_id) {
    // ------------------------------------------------------- update
    const job = await ownJob(admin, ctx, body.job_id);
    if (job.status !== 'quoted' || job.data?.acceptance?.confirmed_at) fail(409, 'This quote has been accepted, so it can\'t be changed here. Call the office to change it.');
    const { q, t } = buildQuote(ctx.rates, ctx.account, clean, installBy, job.data?.quote || {});
    const data = job.data || {};
    data.quote = q;
    data.partner = { ...(data.partner || {}), invoice_to: invoiceTo, install_by: installBy, commission_base: t.commissionBase, updated_at: now, updated_by_name: ctx.user.name };
    const { data: saved, error } = await admin.from('jobs').update({
      data, updated_at: now,
      customer_name: name, customer_phone: phone || null, customer_email: email || null, site_address: address || null,
      account_reference: reference,
      account_id: invoiceTo === 'partner' ? ctx.account.id : null,
      // A rate the office set by hand on this job stands; otherwise follow the
      // install choice.
      commission_pct: data.partner?.commission_overridden ? job.commission_pct : pct,
    }).eq('id', job.id).eq('status', 'quoted').select('id, quote_number').single();
    if (error || !saved) fail(409, 'The quote changed while you were editing. Reload and try again.');
    return { ok: true, job_id: saved.id, quote_number: saved.quote_number, totals: t, created: false };
  }

  // --------------------------------------------------------- create
  const { q, t } = buildQuote(ctx.rates, ctx.account, clean, installBy);
  const { data: ref, error: refErr } = await admin.rpc('next_quote_number');
  if (refErr || !ref) fail(500, 'Couldn\'t get a quote number');

  const row = {
    company_id: ctx.user.company_id,
    quote_number: ref,
    status: 'quoted',
    customer_name: name,
    customer_phone: phone || null,
    customer_email: email || null,
    site_address: address || null,
    account_id: invoiceTo === 'partner' ? ctx.account.id : null,
    account_reference: reference,
    partner_account_id: ctx.account.id,
    partner_user_id: ctx.user.id,
    commission_pct: pct,
    data: {
      job_type: 'fast_quote',
      created_by: `${ctx.user.name} (${ctx.account.name})`,
      quote: q,
      partner: {
        invoice_to: invoiceTo, install_by: installBy,
        submitted_by: ctx.user.id, submitted_by_name: ctx.user.name, submitted_at: now,
        commission_base: t.commissionBase,
      },
      status_history: [{ status: 'quoted', changed_by: who, changed_at: now, note: `Quote raised in the partner portal by ${ctx.account.name}` }],
    },
  };
  const { data: created, error } = await admin.from('jobs').insert(row).select('id, quote_number').single();
  if (error || !created) { console.error('job insert failed', error); fail(500, 'Couldn\'t save the quote'); }

  await sendEmail({
    to: [managerOf(ctx.settings)],
    subject: `New partner quote ${ref} — ${ctx.account.name} — ${money(t.total)}`,
    html: shell(`
      <div style="font-size:18px;font-weight:700;color:#323264;margin:0 0 4px">New quote from ${escapeHtml(ctx.account.name)}</div>
      <div style="font-size:13px;color:#777;margin:0 0 18px">${escapeHtml(name)}${address ? ' — ' + escapeHtml(address) : ''}</div>
      ${table([
        ['Quote', ref], ['Raised by', ctx.user.name], ['Total (inc GST)', money(t.total)],
        ['Commission', `${pct}% — ${money(commissionOf(t.commissionBase, pct))} ex GST`],
        ['Takedown & rehang', installBy === 'partner' ? `${ctx.account.name} does it` : 'Dr Drapes'],
        ['Customer billed by', invoiceTo === 'partner' ? ctx.account.name : 'Dr Drapes'],
        [ctx.account.reference_label || 'Their reference', reference || ''],
      ])}
      <p style="color:#777;font-size:12px;margin:18px 0 0">It's in Drapr under ${escapeHtml(ref)}. The partner sends it to their customer; the office is told when it's accepted.</p>`, 'Partner portal'),
  });

  return { ok: true, job_id: created.id, quote_number: created.quote_number, totals: t, created: true };
}

async function saveInspection(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  if (['in_progress', 'complete', 'invoiced', 'rehung', 'declined'].includes(job.status)) {
    fail(409, 'This job is already with our team, so the pre-inspection can\'t be changed here.');
  }
  const p = body?.pre_inspection || {};
  const checks = (arr: unknown) => (Array.isArray(arr) ? arr : []).slice(0, 30).map((c: any) => ({
    id: String(c?.id ?? '').slice(0, 40), label: String(c?.label ?? '').slice(0, 120), note: String(c?.note ?? '').slice(0, 300),
  })).filter((c) => c.id);
  const score = (v: unknown) => Math.min(10, Math.max(1, parseInt(String(v), 10) || 5));

  const existing = job.data?.pre_inspection || {};
  let photos: any[] = (existing.photos || []).slice();

  // removals first, only photos already on this job
  const remove = new Set((Array.isArray(body?.remove_photos) ? body.remove_photos : []).map(String));
  if (remove.size) {
    const gone = photos.filter((ph) => remove.has(ph.path)).map((ph) => ph.path);
    if (gone.length) await admin.storage.from('job-photos').remove(gone);
    photos = photos.filter((ph) => !remove.has(ph.path));
  }

  const adds = Array.isArray(body?.new_photos) ? body.new_photos : [];
  for (const ph of adds) {
    if (photos.length >= MAX_PHOTOS) break;
    const b64 = String(ph?.base64 ?? '');
    if (!b64 || b64.length > 6_000_000) continue;   // ~4.5MB; the page resizes well under this
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const safe = String(ph?.name ?? 'photo.jpg').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const key = `${Date.now()}_${safe}`;
    const path = `${job.company_id}/${job.id}/pre/${key}`;
    const { error } = await admin.storage.from('job-photos').upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
    if (error) { console.error('photo upload failed', error); continue; }
    photos.push({ key, path, name: String(ph?.name ?? 'photo.jpg').slice(0, 120) });
  }

  const now = new Date().toISOString();
  const pre = {
    ...existing,
    inspector: `${ctx.user.name} (${ctx.account.name})`,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(p.date)) ? p.date : now.slice(0, 10),
    curt_checks: checks(p.curt_checks), blind_checks: checks(p.blind_checks), hw_checks: checks(p.hw_checks),
    curt_na: !!p.curt_na, blind_na: !!p.blind_na,
    curt_score: score(p.curt_score), blind_score: score(p.blind_score),
    cust_notes: String(p.cust_notes ?? '').slice(0, 2000),
    // The partner's own notes for us. Copied into the internal notes the
    // office reads only while nobody here has written there, so a staff note
    // is never overwritten from the portal.
    partner_notes: String(p.job_notes ?? '').slice(0, 2000),
    ...((!existing.job_notes || existing.job_notes_from_partner)
      ? { job_notes: p.job_notes ? `From ${ctx.account.name}: ${String(p.job_notes).slice(0, 2000)}` : '', job_notes_from_partner: true }
      : {}),
    photos,
    saved_at: now,
    by_partner: { user_id: ctx.user.id, name: ctx.user.name, account: ctx.account.name },
  };

  // Re-read and write just this key, so a staff edit to the quote in the same
  // minute isn't overwritten by a stale copy of data.
  const { data: fresh } = await admin.from('jobs').select('data').eq('id', job.id).single();
  const data = { ...(fresh?.data || {}), pre_inspection: pre };
  await admin.from('jobs').update({ data, updated_at: now }).eq('id', job.id);
  return { ok: true, saved_at: now, photos: photos.map((ph) => ({ path: ph.path, name: ph.name })) };
}

async function photoUrl(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  const paths: string[] = (Array.isArray(body?.paths) ? body.paths : [body?.path]).map(String)
    .filter((p) => p.startsWith(`${job.company_id}/${job.id}/`));
  const out: Record<string, string> = {};
  for (const p of paths.slice(0, MAX_PHOTOS * 2)) {
    const { data } = await admin.storage.from('job-photos').createSignedUrl(p, 3600);
    if (data?.signedUrl) out[p] = data.signedUrl;
  }
  return { ok: true, urls: out };
}

async function ensureAcceptToken(admin: any, job: any) {
  if (job.accept_token) return job.accept_token;
  const token = randomToken(24);
  const { data } = await admin.from('jobs')
    .update({ accept_token: token, accept_token_issued_at: new Date().toISOString() })
    .eq('id', job.id).is('accept_token', null).select('accept_token').maybeSingle();
  if (data?.accept_token) return data.accept_token;
  const { data: again } = await admin.from('jobs').select('accept_token').eq('id', job.id).single();
  return again.accept_token;
}

async function emailQuote(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  if (job.status !== 'quoted') fail(409, 'This quote has already been answered.');
  const to = String(body?.to ?? '').trim().toLowerCase();
  if (!validEmail(to)) fail(400, 'Enter the customer\'s email address');
  const pdf = String(body?.pdf_base64 ?? '');
  if (!pdf || pdf.length > 8_000_000) fail(400, 'The quote PDF is missing');

  // A partner login emailing far more than a working day's quotes is not a
  // partner sending quotes.
  const since = Date.now() - 24 * 3600_000;
  const { data: recent } = await admin.from('jobs').select('data').eq('partner_account_id', ctx.account.id).gte('updated_at', new Date(since).toISOString());
  const sentToday = (recent || []).reduce((n: number, j: any) =>
    n + (j.data?.quote?.email_log || []).filter((e: any) => e.partner && new Date(e.sent_at).getTime() > since).length, 0);
  if (sentToday >= 60) fail(429, 'That\'s the limit of quote emails for today. Download the PDF and send it yourself, or call the office.');

  const token = await ensureAcceptToken(admin, job);
  const acceptUrl = `${portalBase(ctx.settings)}accept.html?t=${encodeURIComponent(token)}`;
  const ref = job.quote_number || 'Quote';
  const msg = String(body?.message ?? '').slice(0, 4000) ||
    `Hi ${firstName(job.customer_name)},\n\nPlease find your quote for curtain and blind cleaning attached. ${ctx.account.name} has partnered with Dr Drapes Curtain Clinic to look after your curtains.\n\nYou can accept it online using the button below.\n\nThanks,\n${ctx.user.name}\n${ctx.account.name}`;

  const html = shell(`
    ${paras(msg)}
    <table style="width:100%;border-collapse:collapse;margin:26px 0 8px"><tr><td style="border-top:1px solid #e2e8e7;padding-top:22px">
      <div style="text-align:center">
        <a href="${escapeHtml(acceptUrl)}" style="display:inline-block;background:#0F6E63;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">Review &amp; accept your quote</a>
        <div style="color:#5A6866;font-size:12.5px;margin:12px 0 0">Accept it online whenever suits — or decline it, or ask a question.</div>
        <div style="color:#9aa5a3;font-size:11px;margin:10px 0 0;word-break:break-all">${escapeHtml(acceptUrl)}</div>
      </div></td></tr></table>`, `In partnership with ${ctx.account.name}`);

  const fname = `${ref.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
  const ok = await sendEmail({
    to: [to], cc: [ctx.user.email],
    replyTo: [ctx.user.email, managerOf(ctx.settings)],
    subject: `Your curtain cleaning quote ${ref} — ${ctx.account.name} & Dr Drapes`,
    html, attachments: [{ filename: fname, content: pdf }],
  });
  if (!ok) fail(502, 'The email didn\'t send. Try again in a minute, or download the PDF and send it yourself.');

  const now = new Date().toISOString();
  const { data: fresh } = await admin.from('jobs').select('data').eq('id', job.id).single();
  const data = fresh?.data || {};
  data.quote = data.quote || {};
  data.quote.sent_at = now; data.quote.sent_to = to; data.quote.sent_by = `${ctx.user.name} (${ctx.account.name})`;
  data.quote.email_log = [...(data.quote.email_log || []), { sent_at: now, to, cc: ctx.user.email, subject: `Quote ${ref}`, partner: true }];
  try {
    const path = `${job.company_id}/${job.id}/${fname.replace(/\.pdf$/, '')}-${Date.now()}.pdf`;
    const bytes = Uint8Array.from(atob(pdf), (ch) => ch.charCodeAt(0));
    const { error } = await admin.storage.from('quote-pdfs').upload(path, bytes, { contentType: 'application/pdf', upsert: false });
    if (!error) data.quote.pdf_path = path;
  } catch (e) { console.error('pdf archive failed', e); }
  const cols: any = { data, updated_at: now };
  if (!job.customer_email) cols.customer_email = to;
  await admin.from('jobs').update(cols).eq('id', job.id);
  return { ok: true, sent_at: now };
}

// Same Fergus two-step the accept page uses: raise it only when the match is
// certain, otherwise leave it flagged for the office.
async function pushToFergus(jobId: string) {
  const base = Deno.env.get('SUPABASE_URL')!;
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const call = async (payload: Record<string, unknown>) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 25_000);
    try {
      const res = await fetch(`${base}/functions/v1/push-to-fergus`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
        body: JSON.stringify({ job_id: jobId, ...payload }), signal: ctl.signal,
      });
      return await res.json().catch(() => ({}));
    } finally { clearTimeout(timer); }
  };
  const pv = await call({ preview: true });
  if (!pv?.ok) return { pushed: false, reason: pv?.error || 'Fergus preview failed' };
  if (pv.needs_confirmation) return { pushed: false, needs_confirmation: true, reason: 'new customer or site in Fergus, so the match needs checking' };
  const out = await call({});
  if (!out?.ok) return { pushed: false, reason: out?.error || 'Fergus push failed' };
  return { pushed: true, fergus_job_id: out.fergus_job_id ?? null, fergus_job_no: out.fergus_job_no ?? null, reason: out.already ? 'already in Fergus' : 'raised' };
}

async function customerAccepted(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  if (job.status !== 'quoted') fail(409, 'This quote has already been answered.');
  const name = String(body?.accepted_by ?? '').trim().slice(0, 120) || job.customer_name || 'Customer';
  const note = String(body?.note ?? '').trim().slice(0, 1000);
  const now = new Date().toISOString();
  const who = `${ctx.user.name} (partner)`;
  const data = job.data || {};
  data.acceptance = {
    how: 'partner', terms_confirmed: true, confirmed_at: now, confirmed_by: name,
    partner: { user_id: ctx.user.id, name: ctx.user.name, account: ctx.account.name, note },
  };
  data.status_history = [...(data.status_history || []), {
    status: 'confirmed', changed_by: who, changed_at: now,
    note: `${ctx.account.name} reported the customer accepted${note ? ': ' + note : ''}`,
  }];
  const { data: won } = await admin.from('jobs').update({ data, status: 'confirmed', updated_at: now })
    .eq('id', job.id).eq('status', 'quoted').select('id');
  if (!won?.length) fail(409, 'This quote has already been answered.');

  let fergus: any = { pushed: false, reason: 'not attempted' };
  try { fergus = await pushToFergus(job.id); } catch (e) { fergus = { pushed: false, reason: String(e) }; }
  const { data: after } = await admin.from('jobs').select('data').eq('id', job.id).single();
  const merged = { ...(after?.data ?? data) };
  merged.acceptance = { ...(merged.acceptance ?? data.acceptance), fergus };
  await admin.from('jobs').update({ data: merged }).eq('id', job.id);

  const total = Number(job.data?.quote?.total || 0);
  await sendEmail({
    to: [...new Set([managerOf(ctx.settings), ...officeRecipients(ctx)])],
    subject: `✅ ${job.quote_number} accepted — via ${ctx.account.name} — ${money(total)}`,
    html: shell(`
      <div style="font-size:18px;font-weight:700;color:#1E7A4B;margin:0 0 4px">Partner job accepted</div>
      <div style="font-size:13px;color:#777;margin:0 0 18px">${escapeHtml(job.customer_name || '')}${job.site_address ? ' — ' + escapeHtml(job.site_address) : ''}</div>
      ${table([
        ['Quote', job.quote_number], ['Partner', ctx.account.name], ['Reported by', ctx.user.name],
        ['Customer who accepted', name], ['Total (inc GST)', money(total)], ['Note', note],
        ['Takedown & rehang', job.data?.partner?.install_by === 'partner' ? `${ctx.account.name} does it` : 'Dr Drapes — book it in'],
        ['Fergus', fergus.pushed ? `raised as ${fergus.fergus_job_no || 'a new job'}` : `NOT raised — ${fergus.reason}. Open the job and press Push to Fergus.`],
      ])}`, 'Partner portal'),
  });
  return { ok: true };
}

async function customerDeclined(admin: any, ctx: Ctx, body: any) {
  const job = await ownJob(admin, ctx, body?.job_id);
  if (job.status !== 'quoted') fail(409, 'This quote has already been answered.');
  const reason = DECLINE_REASONS.includes(String(body?.reason)) ? String(body.reason) : 'other';
  const note = String(body?.note ?? '').trim().slice(0, 1000);
  const now = new Date().toISOString();
  const who = `${ctx.user.name} (partner)`;
  const data = job.data || {};
  data.declined = { reason, note, at: now, by: who };
  data.status_history = [...(data.status_history || []), { status: 'declined', changed_by: who, changed_at: now, note: `Declined, reported by ${ctx.account.name}` }];
  const { data: done } = await admin.from('jobs').update({ data, status: 'declined', updated_at: now })
    .eq('id', job.id).eq('status', 'quoted').select('id');
  if (!done?.length) fail(409, 'This quote has already been answered.');
  return { ok: true };
}

// ================================================================== staff

async function sendSetPasswordEmail(admin: any, pu: any, account: any, settings: Record<string, string>, kind: 'invite' | 'reset') {
  const token = randomToken(32);
  const hours = kind === 'invite' ? INVITE_DAYS * 24 : RESET_HOURS;
  await admin.from('partner_users').update({
    invite_token_hash: await sha256(token),
    invite_expires_at: new Date(Date.now() + hours * 3600_000).toISOString(),
    invited_at: new Date().toISOString(),
  }).eq('id', pu.id);
  const base = portalBase(settings);
  const url = `${base}partner.html#invite=${encodeURIComponent(token)}`;
  // A login on a partner that hasn't onboarded yet is the welcome: it sells
  // the arrangement, then walks them into the setup screen.
  const welcome = kind === 'invite' && !account.partner_onboarded_at;
  const hi = pu.name && pu.name !== account.name ? `Hi ${escapeHtml(firstName(pu.name))},` : 'Hi there,';
  const footer = `
      <p style="color:#555;font-size:13px;margin:0 0 10px">The link works once and lasts ${kind === 'invite' ? `${INVITE_DAYS} days` : `${RESET_HOURS} hours`}. After that, sign in any time at <a href="${escapeHtml(base)}partner.html">${escapeHtml(base)}partner.html</a>. It's worth bookmarking.</p>
      <p style="color:#999;font-size:12px;margin:0">Questions? Call Dr Drapes on 1300 652 866.</p>`;

  if (welcome) {
    return sendEmail({
      to: [pu.email], replyTo: managerOf(settings),
      subject: `Welcome to the Dr Drapes partner program — ${account.name}`,
      html: shell(`
        <p style="color:#333;font-size:15px;margin:0 0 14px">${hi}</p>
        <p style="color:#444;font-size:14px;margin:0 0 14px;line-height:1.55">Welcome aboard. <strong>${escapeHtml(account.name)}</strong> is now a Dr Drapes partner. You can quote curtain and blind cleaning for your customers on our price list, and earn commission on every job.</p>
        <p style="color:#444;font-size:14px;margin:0 0 8px;line-height:1.55">How it works:</p>
        <ul style="color:#444;font-size:14px;line-height:1.6;margin:0 0 16px;padding-left:20px">
          <li>Quote in minutes: enter widths and drops and the portal prices it.</li>
          <li>Send your customer a quote with your business name and logo alongside ours, or add our cleaning to your own quote.</li>
          <li>We clean. You or we take down and rehang, whichever suits the job.</li>
          <li>We invoice you at our price less your commission, so the customer stays yours.</li>
          <li>You get an email at every step: accepted, collected, cleaned and ready, invoiced, done.</li>
        </ul>
        ${table([
          ['Your commission', `${Number(account.commission_referral_pct)}% when we take down and rehang · ${Number(account.commission_install_pct)}% when you do`],
          ['Paid on', 'Cleaning and repairs, ex GST'],
          ['Your login', pu.email],
        ])}
        ${button(url, 'Set your password and get started')}
        <p style="color:#555;font-size:13px;margin:0 0 10px">The first time you sign in, you'll add your business details and logo. That takes about two minutes, and then you're ready to quote.</p>
        ${footer}`, 'Partner program'),
    });
  }

  const intro = kind === 'invite'
    ? `You've been set up with a login to the Dr Drapes partner portal for <strong>${escapeHtml(account.name)}</strong>. Use it to quote curtain and blind cleaning on our price list, do pre-inspections, send quotes to your customers and follow each job through to rehang.`
    : 'Someone asked to reset the password for your Dr Drapes partner portal login. Use the button below to set a new one. If it wasn\'t you, ignore this email.';
  return sendEmail({
    to: [pu.email], replyTo: managerOf(settings),
    subject: kind === 'invite' ? `Your Dr Drapes partner login — ${account.name}` : 'Reset your Dr Drapes partner portal password',
    html: shell(`
      <p style="color:#333;font-size:15px;margin:0 0 14px">${hi}</p>
      <p style="color:#555;font-size:14px;margin:0 0 18px;line-height:1.5">${intro}</p>
      ${table([['Business', account.name], ['Login', pu.email]])}
      ${button(url, kind === 'invite' ? 'Set your password' : 'Set a new password')}
      ${footer}`, 'Partner portal'),
  });
}

// Finds or creates the auth user + partner_users row for this email on this
// account. Refuses staff emails and emails already on another partner.
async function ensurePartnerUser(admin: any, account: any, name: string, email: string, phone: string | null) {
  const { data: staffUser } = await admin.from('app_users').select('id').ilike('email', email).maybeSingle();
  if (staffUser) fail(409, 'That email is a Drapr staff login. Partners need their own email address.');

  const { data: existing } = await admin.from('partner_users').select('*').ilike('email', email).maybeSingle();
  if (existing && existing.account_id !== account.id) fail(409, 'That email already has a partner login for a different business.');
  if (existing) {
    const patch: any = { active: true };
    if (name) patch.name = name;
    if (phone) patch.phone = phone;
    await admin.from('partner_users').update(patch).eq('id', existing.id);
    return { ...existing, ...patch };
  }

  let userId: string | null = null;
  const { data: createdUser, error: cErr } = await admin.auth.admin.createUser({
    email, email_confirm: true, password: randomToken(24),
    user_metadata: { partner: true, name },
  });
  if (cErr) {
    // Already in auth (an old login with no profile): reuse it.
    const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const found = (list?.users || []).find((u: any) => (u.email || '').toLowerCase() === email);
    if (!found) { console.error('createUser failed', cErr); fail(500, 'Couldn\'t create the login'); }
    userId = found.id;
  } else {
    userId = createdUser.user.id;
  }
  const { data: inserted, error: iErr } = await admin.from('partner_users').insert({
    // No contact name given: the business name stands in until they enter
    // their own on the onboarding screen.
    id: userId, company_id: account.company_id, account_id: account.id, name: name || account.name, email, phone, active: true,
  }).select('*').single();
  if (iErr) { console.error('partner_users insert failed', iErr); fail(500, 'Couldn\'t create the login'); }
  return inserted;
}

async function invite(admin: any, staff: any, body: any) {
  const accountId = String(body?.account_id ?? '');
  const name = String(body?.name ?? '').trim().slice(0, 120);
  const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 160);
  const phone = String(body?.phone ?? '').trim().slice(0, 40) || null;
  if (!validEmail(email)) fail(400, 'Enter a valid email');

  const { data: account } = await admin.from('accounts').select('*').eq('id', accountId).maybeSingle();
  if (!account || account.company_id !== staff.company_id) fail(404, 'Account not found');
  if (!account.is_partner) fail(400, 'Switch on the partner portal for this account first, and save');

  const pu = await ensurePartnerUser(admin, account, name, email, phone);
  const settings = await loadSettings(admin, account.company_id);
  const sent = await sendSetPasswordEmail(admin, pu, account, settings, 'invite');
  if (!sent) fail(502, 'The login was created but the invite email didn\'t send. Press Resend invite.');
  return { ok: true, partner_user_id: pu.id };
}

// The one-step setup: business name + email. Reuses an existing account of
// the same name (an agent we already deal with), switching the portal on.
async function createPartner(admin: any, staff: any, body: any) {
  const name = String(body?.business_name ?? '').trim().slice(0, 120);
  const email = String(body?.email ?? '').trim().toLowerCase().slice(0, 160);
  const contact = String(body?.contact_name ?? '').trim().slice(0, 120);
  const pct = (v: unknown, d: number) => { const n = Number(v); return isFinite(n) && n >= 0 && n <= 100 && String(v ?? '') !== '' ? n : d; };
  if (name.length < 2) fail(400, 'Enter the business name');
  if (!validEmail(email)) fail(400, 'Enter a valid email');

  const { data: same } = await admin.from('accounts').select('*').eq('company_id', staff.company_id).ilike('name', name).maybeSingle();
  let account = same;
  const partnerCols = {
    is_partner: true, active: true,
    commission_referral_pct: pct(body?.referral_pct, Number(same?.commission_referral_pct ?? 30)),
    commission_install_pct: pct(body?.install_pct, Number(same?.commission_install_pct ?? 50)),
    partner_invoice_default: 'partner',
  };
  if (account) {
    const { data: upd, error } = await admin.from('accounts').update({ ...partnerCols, email: account.email || email, updated_at: new Date().toISOString() })
      .eq('id', account.id).select('*').single();
    if (error) { console.error(error); fail(500, 'Couldn\'t update the account'); }
    account = upd;
  } else {
    const { data: ins, error } = await admin.from('accounts').insert({
      company_id: staff.company_id, name, kind: 'agent', email, reference_label: 'Your reference', reference_required: false,
      ...partnerCols,
    }).select('*').single();
    if (error) { console.error(error); fail(500, 'Couldn\'t create the account'); }
    account = ins;
  }

  const pu = await ensurePartnerUser(admin, account, contact, email, null);
  const settings = await loadSettings(admin, account.company_id);
  const sent = await sendSetPasswordEmail(admin, pu, account, settings, 'invite');
  if (!sent) fail(502, 'The partner was created but the welcome email didn\'t send. Press Resend invite.');
  return { ok: true, account_id: account.id, partner_user_id: pu.id, reused_account: !!same };
}

// ABN check digit: subtract 1 from the first digit, weight, sum, mod 89.
function validAbn(abn: string) {
  const d = abn.replace(/\D/g, '');
  if (d.length !== 11) return false;
  const w = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
  const sum = d.split('').reduce((s, c, i) => s + (Number(c) - (i === 0 ? 1 : 0)) * w[i], 0);
  return sum % 89 === 0;
}

// The onboarding screen, and the Business details page after it.
async function saveProfile(admin: any, ctx: Ctx, body: any) {
  const s = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
  const userName = s(body?.user_name, 120);
  const business = s(body?.business_name, 120);
  const phone = s(body?.phone, 40);
  const email = s(body?.email, 160).toLowerCase();
  const abn = s(body?.abn, 20).replace(/\s+/g, '');
  if (userName.length < 2) fail(400, 'Enter your name');
  if (business.length < 2) fail(400, 'Enter your business name');
  if (!phone) fail(400, 'Enter a business phone number. It prints on your quotes.');
  if (!validEmail(email)) fail(400, 'Enter a business email. It prints on your quotes.');
  if (abn && !validAbn(abn)) fail(400, 'That ABN doesn\'t look right. Check the 11 digits.');

  let logo: string | null | undefined = undefined;           // undefined = leave as is
  if (body?.logo === null) logo = null;
  else if (typeof body?.logo === 'string') {
    if (!/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(body.logo)) fail(400, 'The logo must be a PNG or JPG image');
    if (body.logo.length > 400_000) fail(400, 'That logo is too large. Try a smaller image.');
    logo = body.logo;
  }

  const patch: any = {
    phone, email,
    address_line: s(body?.address_line, 160) || null,
    suburb: s(body?.suburb, 80) || null,
    state: s(body?.state, 10) || 'VIC',
    postcode: s(body?.postcode, 10) || null,
    abn: abn ? abn.replace(/^(\d{2})(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3 $4') : null,
    website: s(body?.website, 160) || null,
    gst_registered: body?.gst_registered === true ? true : body?.gst_registered === false ? false : null,
    updated_at: new Date().toISOString(),
  };
  if (logo !== undefined) patch.partner_logo = logo;
  // The account name is how Fergus finds them until it's linked; once it is,
  // a rename here is just a display change. Before that, keep it in step.
  if (business !== ctx.account.name) patch.name = business;
  if (!ctx.account.partner_onboarded_at) patch.partner_onboarded_at = new Date().toISOString();

  const { error } = await admin.from('accounts').update(patch).eq('id', ctx.account.id);
  if (error) {
    if (/duplicate|unique/i.test(error.message || '')) fail(409, 'Another business already uses that name with us. Call 1300 652 866 and we\'ll sort it.');
    console.error('profile save failed', error); fail(500, 'Couldn\'t save your details');
  }
  await admin.from('partner_users').update({ name: userName, phone: s(body?.user_phone, 40) || null }).eq('id', ctx.user.id);

  if (!ctx.account.partner_onboarded_at) {
    await sendEmail({
      to: [managerOf(ctx.settings)],
      subject: `Partner set up: ${business}`,
      html: shell(`
        <div style="font-size:18px;font-weight:700;color:#323264;margin:0 0 12px">${escapeHtml(business)} has finished setting up</div>
        ${table([
          ['Contact', `${userName} · ${ctx.user.email}`], ['Phone', phone], ['Email', email], ['ABN', patch.abn || 'not given'],
          ['GST registered', patch.gst_registered === null ? 'not said' : patch.gst_registered ? 'Yes' : 'No'],
          ['Address', [patch.address_line, patch.suburb, patch.state, patch.postcode].filter(Boolean).join(' ')],
          ['Logo', logo ? 'uploaded' : 'none yet'],
        ])}
        <p style="color:#777;font-size:12px;margin:18px 0 0">They can quote now. Check the account in Drapr → Admin → Accounts and link it to Fergus if it isn't already.</p>`, 'Partner portal'),
    });
  }
  return { ok: true };
}

async function setActive(admin: any, staff: any, body: any) {
  const id = String(body?.partner_user_id ?? '');
  const { data: pu } = await admin.from('partner_users').select('id, company_id').eq('id', id).maybeSingle();
  if (!pu || pu.company_id !== staff.company_id) fail(404, 'Login not found');
  const active = !!body?.active;
  await admin.from('partner_users').update({ active, ...(active ? {} : { invite_token_hash: null, invite_expires_at: null }) }).eq('id', id);
  // Switching a login off also ends any session it has open right now.
  if (!active) { try { await admin.auth.admin.signOut(id, 'global'); } catch (_) { /* best effort */ } }
  return { ok: true };
}

// ================================================================= public

async function redeemInvite(admin: any, body: any) {
  const token = String(body?.token ?? '');
  if (token.length < 20) fail(400, 'This link isn\'t valid');
  const { data: pu } = await admin.from('partner_users').select('*').eq('invite_token_hash', await sha256(token)).maybeSingle();
  if (!pu || !pu.active) fail(400, 'This link has already been used or has been switched off. Use "Forgot password" on the sign-in page to get a new one.');
  if (!pu.invite_expires_at || new Date(pu.invite_expires_at).getTime() < Date.now()) {
    fail(400, 'This link has expired. Use "Forgot password" on the sign-in page to get a new one.');
  }
  const { data: link, error } = await admin.auth.admin.generateLink({ type: 'recovery', email: pu.email });
  if (error || !link?.properties?.hashed_token) { console.error('generateLink failed', error); fail(500, 'Couldn\'t open the link. Try again.'); }
  await admin.from('partner_users').update({ invite_token_hash: null, invite_expires_at: null }).eq('id', pu.id);
  return { ok: true, token_hash: link.properties.hashed_token, email: pu.email, name: pu.name };
}

async function forgot(admin: any, body: any) {
  const email = String(body?.email ?? '').trim().toLowerCase();
  if (!validEmail(email)) return;
  const { data: pu } = await admin.from('partner_users').select('*').ilike('email', email).maybeSingle();
  if (!pu || !pu.active) return;   // never say whether an address exists
  if (pu.invited_at && Date.now() - new Date(pu.invited_at).getTime() < 60_000) return;
  const { data: account } = await admin.from('accounts').select('*').eq('id', pu.account_id).single();
  if (!account?.is_partner) return;
  const settings = await loadSettings(admin, pu.company_id);
  await sendSetPasswordEmail(admin, pu, account, settings, 'reset');
}

// ================================================================= system

async function partnerRecipients(admin: any, account: any) {
  if (account.partner_notify_email) {
    return String(account.partner_notify_email).split(/[,;\s]+/).map((s) => s.trim()).filter(validEmail);
  }
  const { data } = await admin.from('partner_users').select('email').eq('account_id', account.id).eq('active', true);
  return (data || []).map((u: any) => u.email).filter(Boolean);
}

async function notifyStatus(admin: any, body: any) {
  const { data: job } = await admin.from('jobs').select('*').eq('id', String(body?.job_id ?? '')).maybeSingle();
  if (!job?.partner_account_id) return { ok: true, skipped: 'not a partner job' };
  const status = String(body?.new_status ?? job.status);
  if (status === 'quoted') return { ok: true, skipped: 'quoted' };

  // The partner made this change themselves; they don't need telling.
  const last = (job.data?.status_history || []).slice(-1)[0];
  if (last?.status === status && String(last?.changed_by || '').endsWith('(partner)')) return { ok: true, skipped: 'partner action' };

  const { data: account } = await admin.from('accounts').select('*').eq('id', job.partner_account_id).single();
  if (!account?.is_partner) return { ok: true, skipped: 'portal off' };
  const to = await partnerRecipients(admin, account);
  if (!to.length) return { ok: true, skipped: 'no recipients' };

  const settings = await loadSettings(admin, job.company_id);
  const rates: Rates = Object.fromEntries(RATE_KEYS.map((k) => [k, Number(settings[k] || 0)]));
  const total = Number(job.data?.quote?.total || 0);
  const commission = commissionOf(storedBase(job, rates), job.commission_pct);
  const invoiceTo = job.data?.partner?.invoice_to || 'drdrapes';
  const installBy = job.data?.partner?.install_by || 'drdrapes';
  const ref = job.quote_number;
  const cust = job.customer_name || 'your customer';

  const msgs: Record<string, [string, string]> = {
    confirmed: [`${ref} accepted — ${cust}`,
      `Good news: ${cust} has accepted quote ${ref} (${money(total)} inc GST). ` +
      (installBy === 'partner'
        ? 'You\'re doing the takedown, so let us know when the curtains are ready for us to collect, or drop them in.'
        : 'We\'ll contact the customer to book the takedown.')],
    in_progress: [`${ref} is in our workshop — ${cust}`,
      `We've collected the curtains and blinds for ${cust} and they're being cleaned now.`],
    complete: [`${ref} cleaned and ready — ${cust}`,
      installBy === 'partner'
        ? `The curtains and blinds for ${cust} are cleaned and ready. Let us know when you'd like to collect them for rehanging.`
        : `The curtains and blinds for ${cust} are cleaned and ready. We'll book in the rehang with the customer.`],
    invoiced: [`${ref} invoiced — ${cust}`,
      invoiceTo === 'partner'
        ? `We've invoiced ${account.name} for ${ref}. Your ${Number(job.commission_pct || 0)}% commission (${money(commission)} ex GST) is already taken off that invoice.`
        : `We've invoiced ${cust} for ${ref}. Your ${Number(job.commission_pct || 0)}% commission of ${money(commission)} ex GST will be on next month's statement.`],
    rehung: [`${ref} complete — ${cust}`,
      `Job ${ref} for ${cust} is finished${installBy === 'partner' ? '' : ' and rehung'}. Thanks for the work.`],
    declined: [`${ref} declined — ${cust}`,
      `Quote ${ref} for ${cust} has been marked declined${job.data?.declined?.reason ? ` (${job.data.declined.reason})` : ''}. If you think that's wrong, reply to this email.`],
  };
  const m = msgs[status];
  if (!m) return { ok: true, skipped: 'no message for ' + status };

  const portal = `${portalBase(settings)}partner.html#job=${job.id}`;
  if (status === 'confirmed') {
    await sendEmail({
      to: [managerOf(settings)],
      subject: `✅ ${ref} accepted — via ${account.name} — ${money(total)}`,
      html: shell(`
        <div style="font-size:18px;font-weight:700;color:#1E7A4B;margin:0 0 12px">Partner job accepted</div>
        ${table([['Quote', ref], ['Partner', account.name], ['Customer', cust], ['Total (inc GST)', money(total)],
          ['Commission', `${Number(job.commission_pct || 0)}% — ${money(commission)} ex GST`],
          ['Billed to', invoiceTo === 'partner' ? account.name : 'the customer']])}
        <p style="color:#777;font-size:12px;margin:18px 0 0">The office has it for booking.</p>`, 'Partner portal'),
    });
  }
  await sendEmail({
    to, replyTo: OFFICE, subject: m[0],
    html: shell(`
      <div style="font-size:18px;font-weight:700;color:#323264;margin:0 0 12px">${escapeHtml(STATUS_LABEL[status] || status)}</div>
      ${paras(m[1])}
      ${table([['Quote', ref], ['Customer', cust], ['Site', job.site_address || ''], [account.reference_label || 'Your reference', job.account_reference || '']])}
      ${button(portal, 'Open in the partner portal')}`, `Partner update — ${account.name}`),
  });
  return { ok: true, sent: to.length };
}

// Commission is earned in the month the job was invoiced. Jobs the partner
// bills themselves had commission taken off our invoice to them, so they are
// listed for the record but not owed.
async function statements(admin: any, body: any) {
  const dry = !!body?.dry_run;
  const tz = 'Australia/Melbourne';
  // Month to report: body.month 'YYYY-MM', else last month in Melbourne.
  let y: number, mo: number;
  if (/^\d{4}-\d{2}$/.test(String(body?.month))) { [y, mo] = String(body.month).split('-').map(Number); }
  else {
    const local = new Date(new Date().toLocaleString('en-US', { timeZone: tz }));
    y = local.getFullYear(); mo = local.getMonth();   // getMonth() is 0-based, so this is last month 1-based
    if (mo === 0) { y -= 1; mo = 12; }
  }
  const monthKey = `${y}-${String(mo).padStart(2, '0')}`;
  const label = new Date(y, mo - 1, 1).toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
  const inMonth = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7) === monthKey;

  const { data: accounts } = await admin.from('accounts').select('*').eq('is_partner', true);
  const summary: any[] = [];
  const COMPANY_ID = (accounts || [])[0]?.company_id;
  const liveSettings: Record<string, string> = COMPANY_ID ? await loadSettings(admin, COMPANY_ID) : {};
  const liveRates: Rates = Object.fromEntries(RATE_KEYS.map((k) => [k, Number(liveSettings[k] || 0)]));
  for (const account of accounts || []) {
    const { data: jobs } = await admin.from('jobs').select('*').eq('partner_account_id', account.id).eq('archived', false);
    const rows = (jobs || []).map((j: any) => {
      const inv = (j.data?.status_history || []).filter((h: any) => h.status === 'invoiced').pop();
      if (!inv || !inMonth(inv.changed_at)) return null;
      const base = storedBase(j, liveRates);
      return {
        ref: j.quote_number, customer: j.customer_name || '', reference: j.account_reference || '',
        invoiced: inv.changed_at, base, pct: Number(j.commission_pct || 0),
        commission: commissionOf(base, j.commission_pct),
        billedBy: j.data?.partner?.invoice_to === 'partner' ? 'partner' : 'drdrapes',
      };
    }).filter(Boolean);
    if (!rows.length) continue;
    const owed = round2(rows.filter((r: any) => r.billedBy === 'drdrapes').reduce((s: number, r: any) => s + r.commission, 0));
    const deducted = round2(rows.filter((r: any) => r.billedBy === 'partner').reduce((s: number, r: any) => s + r.commission, 0));
    summary.push({ account: account.name, jobs: rows.length, owed, deducted });

    const tr = rows.map((r: any) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${escapeHtml(r.ref)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px">${escapeHtml(r.customer)}${r.reference ? `<br><span style="color:#888;font-size:11px">${escapeHtml(r.reference)}</span>` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${money(r.base)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${r.pct}%</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right">${money(r.commission)}${r.billedBy === 'partner' ? '<br><span style="color:#888;font-size:11px">deducted on invoice</span>' : ''}</td></tr>`).join('');
    const html = shell(`
      <div style="font-size:18px;font-weight:700;color:#323264;margin:0 0 4px">Commission statement — ${escapeHtml(label)}</div>
      <div style="font-size:13px;color:#777;margin:0 0 18px">${escapeHtml(account.name)}</div>
      <table style="width:100%;border-collapse:collapse">
        <tr><th style="text-align:left;font-size:11px;color:#888;padding:6px 8px">Job</th><th style="text-align:left;font-size:11px;color:#888;padding:6px 8px">Customer</th>
        <th style="text-align:right;font-size:11px;color:#888;padding:6px 8px">Cleaning ex GST</th><th style="text-align:right;font-size:11px;color:#888;padding:6px 8px">Rate</th><th style="text-align:right;font-size:11px;color:#888;padding:6px 8px">Commission</th></tr>
        ${tr}
      </table>
      <div style="margin:18px 0 0">${table([
        ['Commission payable to you (ex GST)', money(owed)],
        ['Already deducted from our invoices to you', deducted ? money(deducted) : ''],
      ])}</div>
      <p style="color:#555;font-size:13px;margin:16px 0 0">Commission is on cleaning and repairs only, ex GST, and is shown here before GST. If you're registered for GST we add it when we pay. Payment goes out this month. Questions — reply to this email.</p>`, 'Partner commission');
    if (!dry) {
      const to = await partnerRecipients(admin, account);
      if (to.length && owed + deducted > 0) await sendEmail({ to, replyTo: managerOf(liveSettings), subject: `Dr Drapes commission statement — ${label}`, html });
    }
  }

  if (summary.length) {
    const to = [managerOf(liveSettings)];
    await sendEmail({
      to, subject: `${dry ? '[TEST] ' : ''}Partner commission to pay — ${label}`,
      html: shell(`
        <div style="font-size:18px;font-weight:700;color:#323264;margin:0 0 14px">Partner commission — ${escapeHtml(label)}</div>
        ${table(summary.map((s) => [s.account, `${money(s.owed)} to pay${s.deducted ? ` · ${money(s.deducted)} deducted on invoice` : ''} · ${s.jobs} job${s.jobs === 1 ? '' : 's'}`] as [string, string]))}
        <p style="color:#555;font-size:13px;margin:16px 0 0">Amounts ex GST. Pay from Xero (RCTI or the partner's invoice), then mark them paid in Drapr → Admin → Partners → Commission.</p>`, 'Partner commission'),
    });
  }
  return { ok: true, month: monthKey, partners: summary };
}
