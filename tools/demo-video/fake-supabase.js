// In-browser stand-in for @supabase/supabase-js, used only to record the Drapr
// demo video. Every table lives in memory (mirrored to localStorage so page
// reloads keep it). Nothing ever leaves the browser.
const LS_KEY = '__drapr_demo_db';
const SEED = window.__DEMO_SEED || {};

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function loadDb() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (_) {}
  return clone(SEED.tables || {});
}
const DB = loadDb();
window.__DEMO_DB = DB;
const persist = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(DB)); } catch (_) {} };
const table = (name) => (DB[name] = DB[name] || []);

// Generated columns the real database computes.
const normPhone = (s) => {
  let d = String(s || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('0011')) d = d.slice(4);
  if (/^61[0-9]{9}$/.test(d)) d = '0' + d.slice(2);
  if (/^[2-9][0-9]{8}$/.test(d)) d = '0' + d;
  return d;
};
const normLoose = (s) => String(s || '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase() || null;
function generated(tbl, row) {
  if (tbl === 'customers') {
    row.phone_norm = normPhone(row.phone);
    row.email_norm = String(row.email || '').trim().toLowerCase() || null;
    row.name_norm = normLoose(row.name);
    if (row.archived === undefined) row.archived = false;
  }
  if (tbl === 'sites') row.address_norm = normLoose((row.address_line || '') + (row.suburb || '') + (row.postcode || ''));
  if (tbl === 'jobs') {
    if (row.archived === undefined) row.archived = false;
    if (row.accept_token === undefined) row.accept_token = null;
  }
  return row;
}

function withDefaults(tbl, row) {
  const now = new Date().toISOString();
  const r = { id: uuid(), created_at: now, ...row };
  if (['jobs', 'customers', 'sites', 'accounts'].includes(tbl) && !r.updated_at) r.updated_at = now;
  if (tbl === 'price_history' && !r.changed_at) r.changed_at = now;
  return generated(tbl, r);
}

const cmp = (a, b) => (a === b ? 0 : a === null || a === undefined ? 1 : b === null || b === undefined ? -1 : a < b ? -1 : 1);

class Query {
  constructor(tbl) {
    this.tbl = tbl; this.filters = []; this.orders = []; this.op = 'select';
    this.lim = null; this.rng = null; this.one = null; this.countMode = null; this.head = false; this.returning = false;
  }
  select(_cols, opts = {}) {
    if (this.op === 'select') { this.countMode = opts.count || null; this.head = !!opts.head; }
    else this.returning = true;
    return this;
  }
  insert(rows) { this.op = 'insert'; this.payload = rows; return this; }
  update(patch) { this.op = 'update'; this.payload = patch; return this; }
  upsert(rows, opts = {}) { this.op = 'upsert'; this.payload = rows; this.conflict = (opts.onConflict || 'id').split(','); return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.filters.push((r) => r[c] === v || (v !== null && r[c] != null && String(r[c]) === String(v))); return this; }
  neq(c, v) { this.filters.push((r) => r[c] !== v); return this; }
  gt(c, v) { this.filters.push((r) => r[c] > v); return this; }
  gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
  lt(c, v) { this.filters.push((r) => r[c] < v); return this; }
  lte(c, v) { this.filters.push((r) => r[c] <= v); return this; }
  in(c, vals) { this.filters.push((r) => vals.includes(r[c])); return this; }
  is(c, v) { this.filters.push((r) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)); return this; }
  not(c, op, v) {
    if (op === 'is' && (v === null || v === 'null')) this.filters.push((r) => r[c] !== null && r[c] !== undefined);
    else if (op === 'eq') this.filters.push((r) => r[c] !== v);
    else if (op === 'in') { const vals = String(v).replace(/[()]/g, '').split(','); this.filters.push((r) => !vals.includes(String(r[c]))); }
    return this;
  }
  contains(c, arr) { this.filters.push((r) => Array.isArray(r[c]) && arr.every((x) => r[c].includes(x))); return this; }
  match(obj) { Object.entries(obj).forEach(([k, v]) => this.eq(k, v)); return this; }
  ilike(c, pat) { const re = new RegExp('^' + String(pat).replace(/%/g, '.*') + '$', 'i'); this.filters.push((r) => re.test(r[c] || '')); return this; }
  or() { return this; }
  filter() { return this; }
  order(c, opts = {}) { this.orders.push({ c, asc: opts.ascending !== false }); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  abortSignal() { return this; }

  run() {
    const t = table(this.tbl);
    const match = (r) => this.filters.every((f) => f(r));
    let rows;
    if (this.op === 'insert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = list.map((p) => withDefaults(this.tbl, clone(p)));
      t.push(...rows);
      persist();
    } else if (this.op === 'upsert') {
      const list = Array.isArray(this.payload) ? this.payload : [this.payload];
      rows = list.map((p) => {
        const hit = t.find((r) => this.conflict.every((k) => r[k] === p[k]));
        if (hit) { Object.assign(hit, clone(p)); generated(this.tbl, hit); return hit; }
        const n = withDefaults(this.tbl, clone(p)); t.push(n); return n;
      });
      persist();
    } else if (this.op === 'update') {
      rows = t.filter(match);
      rows.forEach((r) => { Object.assign(r, clone(this.payload)); generated(this.tbl, r); });
      persist();
    } else if (this.op === 'delete') {
      rows = t.filter(match);
      DB[this.tbl] = t.filter((r) => !match(r));
      persist();
    } else {
      rows = t.filter(match);
    }
    if (this.orders.length) {
      rows = [...rows].sort((a, b) => {
        for (const o of this.orders) { const d = cmp(a[o.c], b[o.c]); if (d) return o.asc ? d : -d; }
        return 0;
      });
    }
    const count = rows.length;
    if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
    if (this.lim != null) rows = rows.slice(0, this.lim);
    rows = clone(rows);
    if (this.op !== 'select' && !this.returning && !this.one) return { data: null, error: null, count };
    if (this.head) return { data: null, error: null, count };
    if (this.one) {
      if (!rows.length) return this.one === 'maybe' ? { data: null, error: null } : { data: null, error: { message: 'No rows', code: 'PGRST116' } };
      return { data: rows[0], error: null, count };
    }
    return { data: rows, error: null, count };
  }
  then(res, rej) {
    return new Promise((r) => setTimeout(r, 25)).then(() => this.run()).then(res, rej);
  }
}

const USER = SEED.user || { id: 'demo-user', email: 'office@demo.com.au' };
const SESSION = { access_token: 'demo-token', user: USER };
let signedIn = SEED.signedIn !== false;

const storageObjects = (window.__DEMO_FILES = window.__DEMO_FILES || {});

export function createClient() {
  return {
    from: (t) => new Query(t),
    rpc: async (name) => {
      if (name === 'next_quote_number') {
        DB.__seq = (DB.__seq || 2470) + 1; persist();
        return { data: 'DRQ-' + DB.__seq, error: null };
      }
      return { data: null, error: null };
    },
    auth: {
      getSession: async () => ({ data: { session: signedIn ? SESSION : null }, error: null }),
      getUser: async () => ({ data: { user: signedIn ? USER : null }, error: null }),
      signInWithPassword: async () => { signedIn = true; return { data: { session: SESSION }, error: null }; },
      signOut: async () => { signedIn = false; return { error: null }; },
      updateUser: async () => ({ data: {}, error: null }),
      verifyOtp: async () => ({ data: {}, error: null }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
    storage: {
      from: () => ({
        upload: async (path, file) => {
          storageObjects[path] = URL.createObjectURL(file);
          return { data: { path }, error: null };
        },
        createSignedUrl: async (path) => ({ data: { signedUrl: storageObjects[path] || (window.__DEMO_PHOTO_URL ? window.__DEMO_PHOTO_URL(path) : '') }, error: null }),
        remove: async () => ({ data: [], error: null }),
      }),
    },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: () => {},
  };
}
export default { createClient };
