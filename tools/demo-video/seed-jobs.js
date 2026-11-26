// Background book of work: ~45 jobs over the last ~10 weeks, plus the van's
// calendar for the next fortnight. Shapes copied from jobs the app itself saved.
const R = (() => { let s = 7; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const pick = (a) => a[Math.floor(R() * a.length)];
const rates = { 'curtain-s': 38, 'curtain-m': 44, 'curtain-l': 52, 'sheer-s': 30, 'sheer-l': 36, 'velvet-s': 56, 'velvet-m': 64, 'velvet-l': 74, roman: 42, 'roller-block': 30, 'roller-sun': 28, venetian: 34, pelmet: 30 };
const r2 = (n) => Math.round(n * 100) / 100;
function line(cat) {
  const w = pick([1200, 1500, 1800, 2400, 2800, 3200, 3600, 4200]);
  const d = pick([1600, 1800, 2100, 2400, 2700, 3000]);
  const mould = R() < 0.2;
  let amount, key;
  if (['curtain', 'sheer', 'velvet'].includes(cat)) {
    const dm = d / 1000;
    key = cat === 'sheer' ? (dm > 3 ? 'sheer-l' : 'sheer-s') : cat + (dm > 3.8 ? '-l' : dm > 2.4 ? '-m' : '-s');
    amount = rates[key] * w / 1000 + (mould ? 12 * w / 1000 : 0);
  } else { key = cat; const sqm = (w / 1000) * (d / 1000); amount = rates[key] * sqm + (mould ? 9 * sqm : 0); }
  return { cat, item_note: '', width: String(w), drop: String(d), mould, amount: r2(amount), rate_used: rates[key] };
}
const ROOMS = ['Lounge', 'Living', 'Dining', 'Main bedroom', 'Bedroom 2', 'Bedroom 3', 'Study', 'Family room', 'Kitchen'];
function quote(nRooms, big = false) {
  const rooms = [];
  for (let i = 0; i < nRooms; i++) {
    const items = [];
    const k = 1 + Math.floor(R() * (big ? 4 : 3));
    for (let j = 0; j < k; j++) items.push(line(pick(['curtain', 'curtain', 'sheer', 'velvet', 'roller-block', 'roman', 'venetian'])));
    rooms.push({ name: big ? 'Room ' + (101 + i * 2) : ROOMS[i % ROOMS.length], items, repairs: [] });
  }
  let sub = rooms.reduce((s, r) => s + r.items.reduce((a, it) => a + it.amount, 0), 0);
  const rehang = big ? 0 : pick([95, 120, 145, 165]);
  sub += rehang;
  sub = r2(sub);
  return { rooms, repairs: [], notes: '', type: 'fast_quote', extras: { rehang: String(rehang || '') }, discount: { type: 'none', value: '' },
    insurer_name: '', claim_number: '', show_rates: true, subtotal: sub, gst: r2(sub * 0.1), total: r2(sub * 1.1), discount_amount: 0 };
}
const PEOPLE = ['Michael Russo', 'Emma Kowalski', 'David Tran', 'Olivia Bennett', 'Priya Sharma', 'Tom Gallagher', 'Grace Liu', 'Hannah Wright', 'Ben Papadopoulos', 'Chloe Martin',
  'Ahmed Hassan', 'Lucy Fraser', 'Nathan Cole', 'Isabella Romano', 'Jack Sullivan', 'Mia Johnson', 'Ryan O\'Brien', 'Sophie Anderson', 'Daniel Kim', 'Zoe Campbell',
  'Kate Morrison', 'Peter Vlahos', 'Amy Nguyen', 'Chris Doyle', 'Laura Pearce', 'Sam Haddad', 'Ella Jenkins', 'Marco Bianchi', 'Fiona Walsh', 'Josh Taylor'];
const SUBS = [['Yarraville', '3013'], ['Footscray', '3011'], ['Altona', '3018'], ['Newport', '3015'], ['Seddon', '3011'], ['Kensington', '3031'], ['Brighton', '3186'], ['Elwood', '3184'],
  ['Caulfield North', '3161'], ['Kew', '3101'], ['Hawthorn', '3122'], ['Camberwell', '3124'], ['Essendon', '3040'], ['Moonee Ponds', '3039'], ['Werribee', '3030'], ['Point Cook', '3030'], ['Sunshine', '3020'], ['Malvern', '3144']];
const STREETS = ['Anderson St', 'Gamon St', 'Pier St', 'Mason St', 'Charles St', 'Macaulay Rd', 'Church St', 'Ormond Rd', 'Balaclava Rd', 'Cotham Rd', 'Burwood Rd', 'Prospect Hill Rd', 'Buckley St', 'Puckle St', 'Watton St', 'Sneydes Rd', 'Hampshire Rd', 'Glenferrie Rd'];
const NOW = Date.now();
const ago = (d, h = 10) => { const t = new Date(NOW - d * 86400000); t.setHours(h, Math.floor(R() * 59), 0, 0); return t.toISOString(); };
const STAFF = ['Sam Carter', 'Priya Desai'];

module.exports = function build(CID) {
  const jobs = []; let drq = 2398, drd = 3470;
  // [status, daysAgoCreated, flowDays...]
  const plan = [];
  // Open quotes at different ages (follow-up ladder).
  [2, 4, 6, 8, 11, 12, 13, 22, 23, 36, 9, 3].forEach((d) => plan.push(['quoted', d]));
  // Declined
  [30, 45, 52, 60].forEach((d) => plan.push(['declined', d]));
  // Accepted and moving
  [5, 7, 10].forEach((d) => plan.push(['confirmed', d]));
  [9, 12, 14, 15].forEach((d) => plan.push(['in_progress', d]));
  [13, 16, 18].forEach((d) => plan.push(['complete', d]));
  [17, 19, 21, 24, 26, 28].forEach((d) => plan.push(['invoiced', d]));
  [25, 30, 33, 38, 41, 47, 55, 62, 68, 74].forEach((d) => plan.push(['rehung', d]));
  const ORDER = ['quoted', 'confirmed', 'in_progress', 'complete', 'invoiced', 'rehung'];
  plan.forEach(([status, d], i) => {
    const name = PEOPLE[i % PEOPLE.length];
    const [sub, pc] = pick(SUBS);
    const street = `${1 + Math.floor(R() * 120)} ${pick(STREETS)}`;
    let account_id = null, account_reference = null, customer_name = name;
    const roll = R();
    if (roll < 0.12) { account_id = 'acc-steam'; account_reference = '#' + (1870000 + Math.floor(R() * 9999)) + '-WST'; }
    else if (roll < 0.22) { account_id = 'acc-dry'; account_reference = 'KEN' + (40000 + Math.floor(R() * 9999)); }
    const big = i === 20 || i === 31;
    if (big) { account_id = i === 20 ? 'acc-aged' : 'acc-hotel'; customer_name = i === 20 ? 'Parkview — East wing' : 'The Harbour Hotel — Level 4'; }
    const q = quote(big ? 6 : 1 + Math.floor(R() * 3), big);
    if (account_id === 'acc-steam') { q.insurer_name = pick(['Allianz', 'Suncorp', 'QBE']); q.claim_number = 'CLM-' + (500000 + Math.floor(R() * 99999)); }
    const created = ago(d);
    const hist = [{ status: 'quoted', changed_by: pick(STAFF), changed_at: created, note: 'Job created' }];
    const idx = ORDER.indexOf(status);
    let t = d;
    const data = { job_type: 'fast_quote', created_by: pick(STAFF), quote: q, status_history: hist };
    q.email_log = [{ sent_at: ago(d, 15), to: 'customer@example.com', subject: 'Quote' }];
    if (status === 'declined') {
      data.declined = { at: ago(d - 8), reason: pick(['price', 'elsewhere', 'timing']), by: pick(STAFF) };
    }
    for (let k = 1; k <= idx; k++) {
      t = Math.max(0.3, t - (k === 1 ? 2 + R() * 3 : 1 + R() * 3));
      hist.push({ status: ORDER[k], changed_by: k === 1 && R() < 0.5 ? name + ' (online)' : pick(STAFF), changed_at: ago(t, 11), note: 'Status changed' });
    }
    if (idx >= 1) data.acceptance = { how: hist[1].changed_by.includes('online') ? 'online' : 'verbal', terms_confirmed: true, confirmed_at: hist[1].changed_at, confirmed_by: name };
    if (status === 'quoted' && d >= 21) data.follow_ups = [{ stage: 1, sent_at: ago(d - 11), sent_by: 'Sam Carter' }];
    if (status === 'quoted' && d >= 35) data.follow_ups.push({ stage: 2, sent_at: ago(d - 22), sent_by: 'Sam Carter' });
    const accepted = idx >= 1;
    jobs.push({ id: 'job-' + i, company_id: CID, quote_number: 'DRQ-' + (drq++), status, customer_name,
      customer_phone: '04' + String(10000000 + Math.floor(R() * 89999999)).slice(0, 2) + ' ' + String(100 + Math.floor(R() * 899)) + ' ' + String(100 + Math.floor(R() * 899)),
      customer_email: name.toLowerCase().replace(/[^a-z]+/g, '.') + '@example.com',
      site_address: `${street}, ${sub} VIC ${pc}`, customer_id: null, site_id: null, account_id, account_reference,
      created_at: created, updated_at: hist[hist.length - 1].changed_at, archived: false, accept_token: null,
      drd_number: accepted ? 'DRD-' + (drd++) : null, fergus_job_id: accepted ? drd : null, data });
  });
  if (drq >= 2466) throw new Error('quote numbers collide');

  // The van's fortnight (Fergus calendar mirror) and today's run sheet.
  const day = (n, h, m) => { const t = new Date(NOW); t.setDate(t.getDate() + n); t.setHours(h, m, 0, 0); return t; };
  const sched = []; let sid = 0;
  const add = (n, h, m, durH, suburb, pc, type, cust) => {
    const s = day(n, h, m); if ([0, 6].includes(s.getDay())) return;
    const e = new Date(s.getTime() + durH * 3600000);
    const sd = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}-${String(s.getDate()).padStart(2, '0')}`;
    sched.push({ id: 'ss-' + (sid++), stop_date: sd, synced_at: new Date(NOW - 600000).toISOString(), starts_at: s.toISOString(), ends_at: e.toISOString(), stop_type: type, customer_name: cust,
      address_line: `${10 + sid} ${pick(STREETS)}`, suburb, state: 'VIC', postcode: pc, assigned_user_ids: [501], description: type === 'takedown' ? 'Take down for cleaning' : 'Rehang cleaned curtains',
      title: `${type === 'takedown' ? 'TD' : 'RH'} ${cust}`, fergus_job_no: 'DRD-' + (3400 + sid), job_id: null, contact_phone: '0400 000 ' + String(100 + sid) });
  };
  for (let n = 1; n <= 14; n++) {
    const dow = day(n, 9, 0).getDay();
    if (dow === 2) { add(n, 9, 0, 1.5, 'Altona', '3018', 'takedown', pick(PEOPLE)); add(n, 13, 30, 1, 'Newport', '3015', 'rehang', pick(PEOPLE)); }
    else if (dow === 4) { add(n, 8, 30, 2, 'Brighton', '3186', 'rehang', pick(PEOPLE)); add(n, 11, 0, 1, 'Elwood', '3184', 'takedown', pick(PEOPLE)); add(n, 14, 0, 1.5, 'Caulfield North', '3161', 'takedown', pick(PEOPLE)); }
    else if (dow === 1) { add(n, 9, 0, 2, 'Kew', '3101', 'rehang', pick(PEOPLE)); add(n, 12, 0, 1.5, 'Hawthorn', '3122', 'takedown', pick(PEOPLE)); }
    else if (dow === 3) { add(n, 9, 30, 1.5, 'Essendon', '3040', 'takedown', pick(PEOPLE)); add(n, 13, 0, 1.5, 'Moonee Ponds', '3039', 'rehang', pick(PEOPLE)); add(n, 15, 0, 1, 'Kensington', '3031', 'takedown', pick(PEOPLE)); }
    else if (dow === 5) { add(n, 9, 0, 3, 'Point Cook', '3030', 'rehang', pick(PEOPLE)); add(n, 13, 30, 1.5, 'Werribee', '3030', 'takedown', pick(PEOPLE)); }
  }
  const today = new Date(NOW); const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const rs = [
    [8, 0, 'rehang', 'Emma Kowalski', '22 Gamon St', 'Yarraville', '3013', 'Rehang lounge + 2 bedrooms. Call when 5 min away.'],
    [10, 30, 'takedown', 'Sarah Mitchell', '14 Ferguson Street', 'Williamstown', '3016', 'Take down lounge curtains + sheers, 2 roller blinds. Side gate, dog is friendly.'],
    [12, 30, 'takedown', 'Kensington Dry Cleaners', '205 Macaulay Rd', 'Kensington', '3031', 'Collect 6 bags from counter. Docket KEN41872.'],
    [14, 0, 'rehang', 'Daniel Kim', '9 Pier St', 'Altona', '3018', 'Rehang 4 panels + valance. Code 2580 for the gate.'],
  ].map(([h, m, type, cust, al, sub, pc, desc], i) => {
    const s = new Date(NOW); s.setHours(h, m, 0, 0);
    return { id: 'rs-' + i, stop_date: ymd, synced_at: new Date(NOW - 600000).toISOString(), starts_at: s.toISOString(), ends_at: new Date(s.getTime() + 5400000).toISOString(), stop_type: type, customer_name: cust,
      address_line: al, suburb: sub, state: 'VIC', postcode: pc, assigned_user_ids: [501], description: desc, title: `${type === 'takedown' ? 'TD' : 'RH'} ${cust}`,
      fergus_job_no: 'DRD-' + (3530 + i), job_id: null, contact_phone: '04' + (12 + i) + ' 555 ' + (100 + i * 37) };
  });
  return { jobs, schedule_stops: sched, run_sheet_stops: rs };
};
