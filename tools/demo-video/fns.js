// Stand-ins for Drapr's Edge Functions. They read and write the same in-browser
// demo database the fake client uses, through the page that made the call.
const ITEM_LABELS = { curtain: 'Standard Curtain / Drape', sheer: 'Sheer Curtain', velvet: 'Velvet / Silk / Linen / Satin', roman: 'Roman Blind', austrian: 'Austrian Blind', 'roller-sun': 'Roller Blind — Sunscreen', 'roller-block': 'Roller Blind — Blockout', venetian: 'Venetian Blind', pelmet: 'Pelmet', swags: 'Swags & Tails', valance: 'Valance on Hooks' };
const metres = (v) => { const n = parseFloat(v); if (!isFinite(n) || n <= 0) return 0; return n >= 100 ? n / 1000 : n; };

// Runs inside the page: mutate the demo DB (live copy if the app is loaded, else localStorage).
async function withDb(page, fnSrc, arg) {
  return page.evaluate(({ fnSrc, arg }) => {
    const live = window.__DEMO_DB;
    const db = live || JSON.parse(localStorage.getItem('__drapr_demo_db') || '{}');
    const fn = new Function('db', 'arg', fnSrc);
    const out = fn(db, arg);
    localStorage.setItem('__drapr_demo_db', JSON.stringify(db));
    return out;
  }, { fnSrc, arg });
}

function buildView(job, company, settings) {
  const q = job.data?.quote || {};
  const detail = (it) => { const w = metres(it.width), d = metres(it.drop); const b = []; if (w && d) b.push(`${w.toFixed(2)}m W × ${d.toFixed(2)}m H`); else if (w) b.push(`${w.toFixed(2)}m W`); if (it.mould) b.push('mould treatment'); if (it.item_note) b.push(String(it.item_note)); return b.join(' · '); };
  const rooms = (q.rooms || []).map((r) => ({ name: r.name || 'Room', lines: [...(r.items || []).map((it) => ({ label: it.cat === 'custom' ? it.label || 'Custom item' : ITEM_LABELS[it.cat] || it.cat, detail: detail(it), amount: Number(it.amount) || 0 })), ...(r.repairs || []).map((x) => ({ label: x.key, detail: 'qty ' + x.qty, amount: Number(x.amount) || 0 }))] })).filter((r) => r.lines.length);
  const ex = q.extras || {}; const extras = [];
  [['transport', 'Transport'], ['rehang', 'Rehang'], ['callout', 'Call-out'], ['storage', 'Storage']].forEach(([k, l]) => { if (Number(ex[k])) extras.push({ label: l, amount: Number(ex[k]) }); });
  const accepted = !!job.data?.acceptance?.confirmed_at || ['confirmed', 'in_progress', 'complete', 'invoiced', 'rehung'].includes(job.status);
  return { quote_number: job.quote_number, quote_date: new Date(job.created_at).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' }),
    customer_first_name: String(job.customer_name || '').split(' ')[0], site_address: job.site_address || '', reference: job.account_reference || q.claim_number || '', insurer: q.insurer_name || '',
    company: { name: company.name, phone: company.contact_phone, email: company.contact_email }, rooms, repairs: [], extras, notes: q.notes || '',
    subtotal: Number(q.subtotal) || 0, gst: Number(q.gst) || 0, total: Number(q.total) || 0, discount_amount: Number(q.discount_amount) || 0,
    terms: settings['terms-text'] || '', outro: '', decided: accepted ? 'accepted' : null, accepted_by: job.data?.acceptance?.confirmed_by || null };
}

const handlers = {
  'send-quote-email': async (req, page) => {
    const b = req.postDataJSON();
    const at = new Date().toISOString();
    await withDb(page, `const j = db.jobs.find(x => x.id === arg.job_id); if (!j) return; j.data = j.data || {}; j.data.quote = j.data.quote || {};
      j.data.quote.email_log = j.data.quote.email_log || []; j.data.quote.email_log.push({ sent_at: arg.at, to: arg.to, subject: arg.subject });`, { ...b, at });
    return { ok: true, sent_at: at };
  },
  'send-inspection-email': async () => ({ ok: true, sent_at: new Date().toISOString() }),
  'push-to-fergus': async (req, page) => {
    const b = req.postDataJSON();
    if (b.preview) return { ok: true, needs_confirmation: false, customer: { name: 'matched' } };
    const no = await withDb(page, `const j = db.jobs.find(x => x.id === arg.job_id); if (!j) return null; if (!j.drd_number) { db.__drd = (db.__drd || 3540) + 1; j.drd_number = 'DRD-' + db.__drd; j.fergus_job_id = db.__drd; } return j.drd_number;`, b);
    return { ok: true, fergus_job_no: no, fergus_job_id: 1 };
  },
  'sync-schedule': async () => ({ ok: true }),
  'sync-run-sheet': async () => ({ ok: true }),
  'quote-portal': async (req, page) => {
    const b = req.postDataJSON();
    if (b.action === 'view') {
      const r = await withDb(page, `const j = db.jobs.find(x => x.accept_token === arg.token); const s = {}; (db.settings||[]).forEach(x => s[x.key] = x.value); return j ? { job: j, company: db.companies[0], settings: s } : null;`, b);
      if (!r) return { error: 'not_found' };
      return { ok: true, quote: buildView(r.job, r.company, r.settings) };
    }
    if (b.action === 'accept') {
      const at = new Date().toISOString();
      await withDb(page, `const j = db.jobs.find(x => x.accept_token === arg.token); if (!j) return;
        j.status = 'confirmed'; j.updated_at = arg.at;
        j.data.acceptance = { how: 'online', terms_confirmed: true, confirmed_at: arg.at, confirmed_by: arg.name, online: { name: arg.name, email: j.customer_email } };
        j.data.status_history = [...(j.data.status_history || []), { status: 'confirmed', changed_by: arg.name + ' (online)', changed_at: arg.at, note: 'Accepted by the customer from the quote link' }];
        db.__drd = (db.__drd || 3540) + 1; j.drd_number = 'DRD-' + db.__drd; j.fergus_job_id = db.__drd;
        j.data.acceptance.fergus = { pushed: true, fergus_job_no: j.drd_number };`, { ...b, at });
      return { ok: true, decision: 'accepted' };
    }
    return { ok: true };
  },
};
module.exports = { handlers, withDb };
