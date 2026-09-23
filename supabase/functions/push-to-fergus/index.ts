// push-to-fergus
//
// Called by Drapr when a quote is accepted. Creates the matching job in
// Fergus (Charge Up, same as we've always raised them by hand) and writes the
// DRD number back onto the Drapr job.
//
// One way only. Nothing in Fergus is ever read back into Drapr except the job id
// and job number at the moment of creation.
//
// POST { job_id: "<uuid>", force?: boolean, preview?: boolean, approved?: {...} }
//   preview resolves the customer and site and reports what it would do,
//   writing nothing, so a person can approve the match first.
//
//   approved carries the decision made against that preview, so what gets
//   written is provably what was on screen:
//     approved: {
//       customer: { action: 'match' | 'new', fergus_id?: number },
//       site:     { action: 'match' | 'new', fergus_id?: number },
//     }
//   'new' forces a fresh Fergus record even when something matched. That is the
//   escape hatch for the case this matcher is most likely to get wrong: the
//   right building, the wrong dwelling inside it.
//
// ACCOUNTS
//   A job can carry an account — the store, restorer or company that sent us
//   the work and pays for it. When it does, the ACCOUNT is the Fergus customer
//   and the end customer is only the site contact. That is the whole point of
//   accounts: before them, "Master Dry Cleaners- Albert Park - Freer, Sue" went
//   to Fergus as a customer name, and the customer matcher below had no way to
//   tell that from the next drop-off at the same store. Six stores became
//   twelve Fergus customers, and the debtor ledger with them.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const FERGUS_BASE = 'https://api.fergus.com';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// ---------------------------------------------------------------- Fergus API

class FergusError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
  }
}

async function fergus(token: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${FERGUS_BASE}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  let body: any = text;
  if (text && (res.headers.get('content-type') || '').includes('application/json')) {
    try { body = JSON.parse(text); } catch { /* leave as text */ }
  }
  if (!res.ok) {
    throw new FergusError(
      res.status === 401
        ? 'Fergus rejected the API token'
        : `Fergus ${init.method || 'GET'} ${path} failed (${res.status})`,
      res.status,
      body,
    );
  }
  return body;
}

// Fergus wraps list responses in { data: [...] } and single reads in { data: {...} }.
const unwrap = (r: any) => (r && typeof r === 'object' && 'data' in r ? r.data : r);

// ------------------------------------------------------------ normalisation

const normEmail = (s?: string | null) =>
  (s || '').trim().toLowerCase() || null;

// Australian mobiles arrive as 0419 878 267, +61419878267, 0419878267. Compare
// on the last nine digits so all three forms match each other.
const normPhone = (s?: string | null) => {
  const d = (s || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
};

// Fergus returns contacts as mainContact.contactItems. A couple of endpoints
// hand back a flattened email/phone instead, so read both shapes.
const contactValues = (customer: any, types: string[]): string[] => {
  const items = (customer?.mainContact?.contactItems || customer?.contactItems || [])
    .filter((i: any) => types.includes(i.contactType))
    .map((i: any) => i.contactValue);
  if (types.includes('email') && customer?.email) items.push(customer.email);
  if (types.includes('phone') && customer?.phone) items.push(customer.phone);
  return items.filter(Boolean);
};

function splitName(full?: string | null) {
  const parts = (full || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Customer', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Drapr holds the site address as one line on older jobs. Split off a trailing
// "VIC 3021" / "3021" so Fergus gets a structured address rather than a blob.
function parseAddress(raw?: string | null) {
  const text = (raw || '').trim();
  const out = {
    address1: text,
    address2: '',
    addressSuburb: '',
    addressCity: '',
    addressRegion: 'Victoria',
    addressPostcode: '',
    addressCountry: 'Australia',
  };
  if (!text) return out;

  const post = text.match(/\b(\d{4})\b\s*$/);
  if (post) out.addressPostcode = post[1];

  let body = post ? text.slice(0, post.index).trim() : text;
  body = body.replace(/[,\s]+(VIC|VICTORIA|NSW|QLD|SA|WA|TAS|NT|ACT)\.?\s*$/i, '').trim();
  body = body.replace(/,\s*$/, '').trim();

  const parts = body.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    out.address1 = parts.slice(0, -1).join(', ');
    out.addressCity = parts[parts.length - 1];
  } else {
    out.address1 = body || text;
  }
  return out;
}

// Fergus validates address fields as "must not be empty" but accepts them being
// absent altogether — so a thin address like "155 Railway St" with no suburb or
// postcode only goes through if the blank keys are dropped rather than sent as "".
function compactAddress(a: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(a)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

// Drapr keeps an address as one typed line ("52 Anderson St Lalor"); Fergus keeps
// it split and spelled out ("52 Anderson Street" + "Lalor" + "3075"). Comparing
// them literally never matches, so both sides are reduced to a token set with
// street types expanded and state/country noise dropped.
const STREET_TYPES: Record<string, string> = {
  st: 'street', str: 'street', rd: 'road', av: 'avenue', ave: 'avenue',
  cr: 'crescent', cres: 'crescent', ct: 'court', crt: 'court', pde: 'parade',
  hwy: 'highway', dr: 'drive', drv: 'drive', ln: 'lane', pl: 'place',
  tce: 'terrace', blvd: 'boulevard', bvd: 'boulevard', cl: 'close',
  gr: 'grove', gve: 'grove', sq: 'square', wy: 'way', esp: 'esplanade',
};
// Dwelling words are noise for the street comparison, because the dwelling
// itself is compared separately and exactly — see unitNumber / unitsAgree.
const ADDRESS_NOISE = new Set([
  'vic', 'victoria', 'nsw', 'qld', 'sa', 'wa', 'tas', 'nt', 'act',
  'australia', 'unit', 'apt', 'apartment', 'level', 'lvl', 'suite', 'ste',
  'shop', 'flat',
]);

function addressTokens(...parts: (string | null | undefined)[]): Set<string> {
  const raw = parts.filter(Boolean).join(' ').toLowerCase();
  return new Set(
    raw.replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter(Boolean)
      .map((t) => STREET_TYPES[t] || t)
      .filter((t) => !ADDRESS_NOISE.has(t)),
  );
}

// The number that identifies the building. Handles "11", "2Q", "27-29 Claremont"
// and "t14/299 Toorak Road", where the unit prefix is set aside because it is
// compared on its own — see unitNumber.
function streetNumber(raw?: string | null): string | null {
  const s = (raw || '').replace(/^[^/]*\//, '').trim();
  const m = s.match(/^(\d+[a-zA-Z]?)\b/);
  return m ? m[1].toLowerCase() : null;
}

// The dwelling within the building. This is what tells 2/273 Lygon Street from
// 108/273 Lygon Street. Dropping it once attached a job — and every customer
// email that follows a job — to a stranger's apartment in the same block.
//
// Handles "2/273", "Unit 106 /186", "level 3/116", "t14/299" and the unslashed
// "Unit 5 186 Tooronga Road".
const DWELLING_WORDS = /^(?:unit|apt|apartment|level|lvl|suite|ste|shop|flat)\s*\.?\s*/i;

function unitNumber(raw?: string | null): string | null {
  const s = (raw || '').trim();
  if (!s) return null;

  const slash = s.match(/^\s*(.+?)\s*\//);
  if (slash) {
    const u = slash[1].replace(DWELLING_WORDS, '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return u || null;
  }

  const word = s.match(/^\s*(?:unit|apt|apartment|level|lvl|suite|ste|shop|flat)\s*\.?\s*([a-z0-9]+)/i);
  return word ? word[1].toLowerCase() : null;
}

// Both sides naming the same dwelling is the only safe outcome. Different units
// are plainly different homes. One side naming a unit and the other not is not
// agreement either — it is one record being thinner than the other, and there is
// no way to tell which of the building's dwellings it meant. Both cases fall
// through to creating a separate site, because a duplicate site record costs
// nothing next to sending a truck, an invoice or an email to the wrong door.
function unitsAgree(aLine?: string | null, bLine?: string | null): boolean {
  const ua = unitNumber(aLine);
  const ub = unitNumber(bLine);
  if (ua && ub) return ua === ub;
  return !ua && !ub;
}

const postcodeOf = (x: { line?: string; pc?: string }) => {
  const direct = (x.pc || '').trim().match(/^\d{4}$/);
  if (direct) return direct[0];
  const m = (x.line || '').match(/\b(\d{4})\b\s*$/);
  return m ? m[1] : null;
};

// Postcodes only ever disagree when the properties are genuinely in different
// places, so a mismatch is decisive. A postcode missing from either side says
// nothing and is not held against the match.
function postcodesAgree(a: { line?: string; pc?: string }, b: { line?: string; pc?: string }) {
  const pa = postcodeOf(a);
  const pb = postcodeOf(b);
  if (pa && pb) return pa === pb;
  return true;
}

// Compare only the word tokens: street name, street type, suburb. Anything
// carrying a digit is dropped here, because the two sides reliably disagree on
// those. The numbers that actually identify a property — street number, unit
// and postcode — are each checked separately and exactly.
function sameStreet(a: Set<string>, b: Set<string>) {
  const words = (s: Set<string>) => new Set([...s].filter((t) => !/\d/.test(t)));
  const wa = words(a), wb = words(b);
  if (wa.size < 2 || wb.size < 2) return false;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  for (const t of small) if (!big.has(t)) return false;
  return true;
}

// Containment alone is not enough. A Drapr site holding only "Surrey hills" is
// contained in "61 Weybridge Street, Surrey hills VIC 3127", which once put a
// job on a stranger's property. Both sides must name the same street number and
// the same dwelling, must not contradict each other on postcode, and an address
// with no street number can't be matched to anything at all.
function addressMatches(
  a: { line: string; city: string; pc: string },
  b: { line: string; city: string; pc: string },
) {
  const na = streetNumber(a.line);
  const nb = streetNumber(b.line);
  if (!na || !nb || na !== nb) return false;
  if (!unitsAgree(a.line, b.line)) return false;
  if (!postcodesAgree(a, b)) return false;
  return sameStreet(
    addressTokens(a.line, a.city, a.pc),
    addressTokens(b.line, b.city, b.pc),
  );
}

// Fergus reads the suburb off addressCity, which is what the existing jobs use.
function addressFromSite(site: any, fallbackLine?: string | null) {
  const siteLine = (site?.address_line || '').trim();
  const jobLine = (fallbackLine || '').trim();
  // The sites table sometimes holds only a suburb ("Surrey hills") while the job
  // itself carries the real street address. Take whichever names a property.
  const line = (!streetNumber(siteLine) && streetNumber(jobLine)) ? jobLine : (siteLine || jobLine);
  const a = parseAddress(line);
  if (!site) return a;
  return {
    ...a,
    addressCity: site.suburb || a.addressCity,
    addressRegion: site.state === 'VIC' ? 'Victoria' : (site.state || a.addressRegion),
    addressPostcode: site.postcode || a.addressPostcode,
  };
}

// Fergus full-text search chokes on a whole typed line, so search on the street
// number and name only — dropping any unit prefix, so the search returns every
// dwelling in the building and the exact tests above pick between them.
function siteSearchTerm(address1: string) {
  return address1.replace(/^[^/]*\//, '').trim().split(/\s+/).slice(0, 2).join(' ');
}

// ------------------------------------------------------------ name matching

// Words worth comparing on a name: three letters or more, so "PO", "&", "St"
// don't count as agreement between two otherwise-unrelated names.
function normNameWords(s?: string | null): Set<string> {
  return new Set(
    (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
      .filter((w) => w.length >= 3),
  );
}

// A Drapr customer row that already carries a fergus_customer_id is normally
// trusted outright — see resolveCustomer below. But a handful of jobs get
// logged against a shared placeholder customer (an ad-hoc "special job" entry)
// instead of a proper one per referrer. The first push from that placeholder
// caches whatever Fergus id it matched, and every later job filed under the
// same placeholder — for a completely different real customer — would
// otherwise inherit that cached id silently, with no approval prompt, because
// wasLinked short-circuits needs_confirmation.
//
// So the cache is only trusted when the job's own customer name still shares
// a real word with the Drapr customer record it's filed under. No shared word
// means this job almost certainly isn't who the cache was set for, so fall
// through to a fresh match — which still surfaces the approval popup rather
// than silently reusing a stranger's Fergus link.
function nameLooksLinked(job: any, customer: any): boolean {
  const stored = new Set([
    ...normNameWords(customer?.name),
    ...normNameWords(customer?.business_name),
  ]);
  const incoming = new Set([
    ...normNameWords(job?.customer_name),
    ...normNameWords(job?.business_name),
  ]);
  // Nothing to compare against (blank names either side) — keep the old
  // trust-the-cache behaviour rather than force a confirmation on every job.
  if (!stored.size || !incoming.size) return true;
  for (const w of incoming) if (stored.has(w)) return true;
  return false;
}

// The address says which building. Whose name is on the site says which home
// inside it.
//
// An address alone cannot be trusted here, because the two systems record
// dwellings inconsistently and a whole block of flats collapses to one street
// number. So a matched site has to be corroborated by the person as well: a
// shared phone, a shared email, or a shared word in the name. A site plainly
// belonging to somebody we don't recognise is reported as a conflict, and the
// job gets its own site instead.
//
// Returns the conflicting name (or a placeholder) when the site belongs to
// someone else, or null when the site is safe to use.
function siteContactConflict(site: any, job: any, customer: any): string | null {
  const dc = site?.defaultContact || {};
  const items: any[] = dc.contactItems || [];

  const ourPhone = normPhone(customer?.phone || job.customer_phone);
  const ourEmail = normEmail(customer?.email || job.customer_email);

  const theirPhones = items
    .filter((i) => ['mobile', 'phone'].includes(i.contactType))
    .map((i) => normPhone(i.contactValue)).filter(Boolean);
  const theirEmails = items
    .filter((i) => i.contactType === 'email')
    .map((i) => normEmail(i.contactValue)).filter(Boolean);

  // A shared identifier is proof enough that this is our customer's property.
  if (ourPhone && theirPhones.includes(ourPhone)) return null;
  if (ourEmail && theirEmails.includes(ourEmail)) return null;

  const theirName = [dc.firstName, dc.lastName].filter(Boolean).join(' ').trim();

  // Fergus holds nobody against this site, so there is nothing to contradict us.
  if (!theirName && !theirPhones.length && !theirEmails.length) return null;

  const ours = new Set([
    ...normNameWords(customer?.name),
    ...normNameWords(customer?.business_name),
    ...normNameWords(job?.customer_name),
    ...normNameWords(job?.business_name),
  ]);
  const theirs = normNameWords(theirName);
  for (const w of theirs) if (ours.has(w)) return null;

  return theirName || 'someone else';
}

// -------------------------------------------------------------- job framing

const BLIND_CATS = new Set(['roman', 'austrian', 'roller-sun', 'roller-block', 'venetian']);
const CURTAIN_CATS = new Set(['curtain', 'sheer', 'velvet', 'pelmet', 'swags', 'valance']);

// "Curtain & Blind Cleaning" — matches how these jobs have always been titled.
function jobTitle(job: any) {
  const rooms = job?.data?.quote?.rooms || [];
  let curtains = false, blinds = false;
  for (const room of rooms) {
    for (const item of room.items || []) {
      if (BLIND_CATS.has(item.cat)) blinds = true;
      else if (CURTAIN_CATS.has(item.cat)) curtains = true;
    }
  }
  if (curtains && blinds) return 'Curtain & Blind Cleaning';
  if (blinds) return 'Blind Cleaning';
  if (curtains) return 'Curtain Cleaning';
  return 'Curtain & Blind Cleaning';
}

// ------------------------------------------------------------- the decision

// What a person chose against the preview they were shown.
type Decision = { action?: string; fergus_id?: number | null } | null | undefined;

const forcesNew = (d: Decision) => d?.action === 'new';
const pinnedId = (d: Decision) =>
  d?.action === 'match' && Number(d.fergus_id) ? Number(d.fergus_id) : null;

// ---------------------------------------------------- account resolution

// When the job carries an account, the account is the Fergus customer and
// there is nothing to guess: the id is cached on the account row the first
// time a person approves it, and every job from that store afterwards goes
// straight to the same Fergus customer and the same Xero contact.
//
// An account with no cached id is the only case that does any searching, and
// it never creates silently. It offers an exact name match for approval, or
// says it will create one, and always asks. Accounts are created rarely and
// by an admin; a wrong or duplicated one costs a whole store's ledger, so it
// is worth one interruption.
async function resolveAccountCustomer(
  token: string, sb: any, account: any, dry = false, decision: Decision = null,
) {
  const contacts = [account.phone, account.email].filter(Boolean);

  const cache = async (id: number) => {
    if (!dry && account?.id) {
      await sb.from('accounts').update({ fergus_customer_id: id }).eq('id', account.id);
    }
  };

  const pinned = pinnedId(decision);
  if (pinned) {
    await cache(pinned);
    return { id: pinned, created: false, wasLinked: false, name: account.name, contacts };
  }

  const forceNew = forcesNew(decision);

  if (!forceNew && account.fergus_customer_id) {
    return {
      id: Number(account.fergus_customer_id), created: false, wasLinked: true,
      name: account.name, contacts,
    };
  }

  // Exact name only. A loose match is what produced "Master Dry Cleaners",
  // "Master Dry Cleaners- Albert Park" and "Master Dry Cleaners Albert Park -
  // Alan Shaw" as three separate Fergus customers; anything less than exact
  // gets put to a person rather than guessed at.
  let match: any = null;
  if (!forceNew) {
    const res = unwrap(await fergus(
      token, `/customers?pageSize=20&filterSearchText=${encodeURIComponent(account.name)}`));
    const wanted = account.name.trim().toLowerCase();
    const hits = (Array.isArray(res) ? res : [])
      .filter((c: any) => (c.customerFullName || c.name || '').trim().toLowerCase() === wanted);
    if (hits.length === 1) match = hits[0];
  }

  if (match?.id) {
    // Still reported as not linked, so the preview asks before the id is cached.
    return {
      id: Number(match.id), created: false, wasLinked: false,
      name: match.customerFullName || match.name || account.name,
      contacts: contactValues(match, ['mobile', 'phone', 'email']),
    };
  }

  const { firstName, lastName } = splitName(account.name);
  const contactItems: any[] = [];
  if (account.phone) contactItems.push({ contactType: 'phone', contactValue: account.phone });
  if (account.email) contactItems.push({ contactType: 'email', contactValue: account.email });

  const body: any = {
    customerFullName: account.name,
    mainContact: { firstName, lastName, company: account.name, contactItems },
  };
  const addr = compactAddress({
    address1: account.address_line || '',
    addressCity: account.suburb || '',
    addressRegion: account.state === 'VIC' ? 'Victoria' : (account.state || ''),
    addressPostcode: account.postcode || '',
    addressCountry: 'Australia',
  });
  if (addr.address1) body.physicalAddress = addr;

  if (dry) {
    return { id: null, created: true, wasLinked: false, name: account.name, contacts };
  }
  const id = Number(unwrap(await fergus(token, '/customers', {
    method: 'POST', body: JSON.stringify(body),
  }))?.id);
  if (!id) throw new Error('Fergus did not return a customer id');
  await cache(id);
  return { id, created: true, wasLinked: false, name: account.name, contacts };
}

// ------------------------------------------------------- customer resolution

async function resolveCustomer(
  token: string, sb: any, job: any, customer: any, dry = false, decision: Decision = null,
) {
  // A decision taken against a preview wins outright, so what gets written is
  // exactly what was on screen rather than whatever a second, independent
  // resolution happens to turn up a moment later.
  const pinned = pinnedId(decision);
  if (pinned) {
    if (!dry && customer?.id) {
      await sb.from('customers').update({ fergus_customer_id: pinned }).eq('id', customer.id);
    }
    return {
      id: pinned, created: false, wasLinked: false,
      name: customer?.name || job.customer_name || '', contacts: [],
    };
  }
  const forceNew = forcesNew(decision);

  // Already linked, and the job still looks like it belongs to this Drapr
  // customer — no guessing has to happen for this customer ever again, which
  // is why the confirmation step only fires on the first job. See
  // nameLooksLinked for why the name check exists.
  if (!forceNew && customer?.fergus_customer_id && nameLooksLinked(job, customer)) {
    return {
      id: Number(customer.fergus_customer_id), created: false, wasLinked: true,
      name: customer?.name || job.customer_name || '', contacts: [],
    };
  }

  const email = normEmail(customer?.email || job.customer_email);
  const phone = normPhone(customer?.phone || job.customer_phone);
  const name = (customer?.business_name || customer?.name || job.customer_name || '').trim();

  const search = async (term: string) => {
    const res = unwrap(await fergus(token, `/customers?pageSize=20&filterSearchText=${encodeURIComponent(term)}`));
    return Array.isArray(res) ? res : [];
  };

  // Fergus full-text search is loose — a search for "Smith" returns Naismith and
  // anyone whose email merely contains it. So every hit is re-checked exactly.
  //
  // Each identifier gets its own search and its own exact test, strongest first,
  // stopping only on a confirmed match. Searching once and testing three ways
  // would miss a customer whose email search returns near-misses when a phone
  // search would have found them exactly.
  //
  // One identifier matching is not proof of identity either. Business emails get
  // reused across Fergus customer records — david@hudsongroup.com.au sits on both
  // "David Hudson" and "Linx Restorations" — and a single mobile can sit on
  // several. So when a test returns more than one candidate, narrow with the
  // identifiers not yet spent.
  const narrow = (list: any[]) => {
    if (list.length <= 1) return list;
    if (phone) {
      const byPhone = list.filter((c) =>
        contactValues(c, ['mobile', 'phone']).some((v) => normPhone(v) === phone));
      if (byPhone.length === 1) return byPhone;
      if (byPhone.length) list = byPhone;
    }
    if (name) {
      const n = name.toLowerCase();
      const byName = list.filter((c) =>
        (c.customerFullName || c.name || '').trim().toLowerCase() === n);
      if (byName.length === 1) return byName;
      // Several Fergus customers share this identifier and not one of them
      // carries the customer's name — a shared mobile or an office switchboard,
      // not this person. Conclude "new customer" rather than stalling the job.
      // A single candidate never reaches here (narrow returns early), so a lone
      // phone match with a spelling variation on the name still matches.
      if (byName.length === 0) return [];
    }
    return list;
  };

  let matches: any[] = [];

  // A forced new customer skips every search — the person has already looked at
  // what we found and said it is none of them.
  if (!forceNew) {
    if (email) {
      matches = narrow((await search(email))
        .filter((c) => contactValues(c, ['email']).some((v) => normEmail(v) === email)));
    }

    const rawPhone = customer?.phone || job.customer_phone;
    if (!matches.length && phone && rawPhone) {
      matches = narrow((await search(String(rawPhone)))
        .filter((c) => contactValues(c, ['mobile', 'phone']).some((v) => normPhone(v) === phone)));
    }

    if (!matches.length && name) {
      const n = name.toLowerCase();
      matches = narrow((await search(name))
        .filter((c) => (c.customerFullName || c.name || '').trim().toLowerCase() === n));
    }

    // Dedupe — the same customer can satisfy more than one test.
    matches = [...new Map(matches.filter((c) => c?.id).map((c) => [c.id, c])).values()];
  }

  if (matches.length > 1) {
    throw Object.assign(new Error('More than one Fergus customer matches'), {
      code: 'ambiguous_customer',
      candidates: matches.slice(0, 5).map((c) => ({ id: c.id, name: c.customerFullName })),
    });
  }

  let id: number | null = null;
  let created = false;
  let resolvedName = '';
  let contacts: string[] = [];

  if (matches.length === 1) {
    const m = matches[0];
    id = m.id;
    resolvedName = m.customerFullName || m.name || '';
    contacts = contactValues(m, ['mobile', 'phone', 'email']);
  } else {
    const { firstName, lastName } = splitName(customer?.name || job.customer_name);
    const contactItems: any[] = [];
    if (customer?.phone || job.customer_phone) {
      contactItems.push({ contactType: 'mobile', contactValue: customer?.phone || job.customer_phone });
    }
    if (customer?.email || job.customer_email) {
      contactItems.push({ contactType: 'email', contactValue: customer?.email || job.customer_email });
    }
    const body: any = {
      customerFullName: name || `${firstName} ${lastName}`.trim(),
      mainContact: { firstName, lastName, contactItems },
    };
    if (customer?.business_name) body.mainContact.company = customer.business_name;
    const addr = addressFromSite(null, job.site_address);
    if (addr.address1) body.physicalAddress = compactAddress(addr);

    resolvedName = body.customerFullName;
    contacts = contactItems.map((c: any) => c.contactValue);
    created = true;
    // Preview stops here: nothing is written to Fergus and nothing is cached.
    if (dry) return { id: null, created, wasLinked: false, name: resolvedName, contacts };
    id = Number(unwrap(await fergus(token, '/customers', { method: 'POST', body: JSON.stringify(body) }))?.id);
  }

  if (!id) throw new Error('Fergus did not return a customer id');
  if (!dry && customer?.id) {
    await sb.from('customers').update({ fergus_customer_id: id }).eq('id', customer.id);
  }
  return { id, created, wasLinked: false, name: resolvedName, contacts };
}

// ----------------------------------------------------------- site resolution

async function resolveSite(
  token: string, sb: any, job: any, site: any, customer: any, dry = false, decision: Decision = null,
) {
  const pinned = pinnedId(decision);
  if (pinned) {
    if (!dry && site?.id) {
      await sb.from('sites').update({ fergus_site_id: pinned }).eq('id', site.id);
    }
    return {
      id: pinned, created: false, wasLinked: false,
      address: [site?.address_line, site?.suburb, site?.postcode].filter(Boolean).join(', '),
      contact: '', conflict: null,
    };
  }
  const forceNew = forcesNew(decision);

  if (!forceNew && site?.fergus_site_id) {
    return {
      id: Number(site.fergus_site_id), created: false, wasLinked: true,
      address: [site.address_line, site.suburb, site.postcode].filter(Boolean).join(', '),
      contact: '', conflict: null,
    };
  }

  const addr = addressFromSite(site, job.site_address);
  const proposed = [addr.address1, addr.addressCity, addr.addressPostcode].filter(Boolean).join(', ');

  let id: number | undefined;
  let created = false;
  let matchedAddress = '';
  let matchedContact = '';
  let conflict: string | null = null;
  // The site we refused to use, kept so a person can still choose it on purpose
  // — a couple with different surnames at one address, say. Never used unless
  // it comes back as an explicit 'match' decision.
  let conflictId: number | null = null;
  let conflictAddress = '';

  // No street number means nothing we can safely match against, so skip straight
  // to creating a site carrying whatever address we do hold.
  if (!forceNew && addr.address1 && streetNumber(addr.address1)) {
    const term = siteSearchTerm(addr.address1);
    const res = unwrap(await fergus(token, `/sites?pageSize=20&filterSearchText=${encodeURIComponent(term)}`));
    const mine = { line: addr.address1, city: addr.addressCity, pc: addr.addressPostcode };
    const hits = (Array.isArray(res) ? res : []).filter((s: any) => {
      const a = s.siteAddress || s.physicalAddress || s;
      return addressMatches(mine, {
        line: a.address1 || '', city: a.addressCity || '', pc: a.addressPostcode || '',
      });
    });
    // Exactly one is a confident match on address. Several means the address we
    // hold is too thin to tell them apart — same street number and street,
    // different suburb — and sending a truck to the wrong house is worse than a
    // duplicate site record, so fall through and create one carrying the address
    // as typed.
    if (hits.length === 1 && hits[0]?.id) {
      // The list response is a summary. Read the site in full, because the
      // decision below turns on defaultContact.contactItems, which only the
      // single-site read reliably carries.
      let full = hits[0];
      try {
        full = unwrap(await fergus(token, `/sites/${hits[0].id}`)) || hits[0];
      } catch (_) {
        // Fall back to the summary; the name comparison still applies.
      }
      const a = full.siteAddress || full.physicalAddress || {};
      const dc = full.defaultContact || {};
      // Whose site Fergus thinks this is. Showing this is what makes a wrong
      // match obvious to a human at a glance.
      matchedContact = [dc.firstName, dc.lastName].filter(Boolean).join(' ');
      conflict = siteContactConflict(full, job, customer);
      const found = [a.address1, a.addressCity, a.addressPostcode].filter(Boolean).join(', ');
      if (conflict) {
        conflictId = full.id || hits[0].id;
        conflictAddress = found;
      } else {
        id = full.id || hits[0].id;
        matchedAddress = found;
      }
    }
  }

  if (!id) {
    const { firstName, lastName } = splitName(customer?.name || job.customer_name);
    const contactItems: any[] = [];
    if (customer?.phone || job.customer_phone) {
      contactItems.push({ contactType: 'mobile', contactValue: customer?.phone || job.customer_phone });
    }
    if (customer?.email || job.customer_email) {
      contactItems.push({ contactType: 'email', contactValue: customer?.email || job.customer_email });
    }
    const body: any = {
      siteAddress: compactAddress(addr),
      defaultContact: { firstName, lastName, contactItems },
    };
    if (site?.name) body.name = site.name;
    created = true;
    if (dry) {
      return {
        id: null, created, wasLinked: false, address: proposed,
        contact: `${firstName} ${lastName}`.trim(),
        conflict, conflictId, conflictAddress,
      };
    }
    id = Number(unwrap(await fergus(token, '/sites', { method: 'POST', body: JSON.stringify(body) }))?.id);
  }

  if (!id) throw new Error('Fergus did not return a site id');
  if (!dry && site?.id) {
    await sb.from('sites').update({ fergus_site_id: id }).eq('id', site.id);
  }
  return {
    id, created, wasLinked: false,
    address: matchedAddress || proposed,
    contact: matchedContact,
    conflict, conflictId, conflictAddress,
  };
}

// -------------------------------------------------------------------- handler

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

  const token = Deno.env.get('FERGUS_API_TOKEN');
  if (!token) {
    return json({ ok: false, code: 'no_token', error: 'FERGUS_API_TOKEN is not set on this project' }, 500);
  }

  const sb = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  let payload: any;
  try { payload = await req.json(); } catch { return json({ ok: false, error: 'Body must be JSON' }, 400); }

  const jobId = payload?.job_id;
  if (!jobId) return json({ ok: false, error: 'job_id is required' }, 400);

  try {
    const { data: job, error } = await sb.from('jobs').select('*').eq('id', jobId).single();
    if (error || !job) return json({ ok: false, code: 'job_not_found', error: 'Job not found in Drapr' }, 404);

    // Already pushed. Don't raise a second Fergus job for the same quote.
    if (job.fergus_job_id && !payload.force) {
      return json({
        ok: true,
        created: false,
        already: true,
        fergus_job_id: Number(job.fergus_job_id),
        fergus_job_no: job.fergus_job_no || job.drd_number,
      });
    }

    const [{ data: customer }, { data: site }, { data: account }] = await Promise.all([
      job.customer_id
        ? sb.from('customers').select('*').eq('id', job.customer_id).single()
        : Promise.resolve({ data: null }),
      job.site_id
        ? sb.from('sites').select('*').eq('id', job.site_id).single()
        : Promise.resolve({ data: null }),
      job.account_id
        ? sb.from('accounts').select('*').eq('id', job.account_id).single()
        : Promise.resolve({ data: null }),
    ]);

    // Preview resolves the match and reports it without writing anything to
    // Fergus or caching any ids, so a person can approve it first.
    const preview = !!payload.preview;
    const approved = payload?.approved || null;

    // The account is the customer when there is one. The end customer stays on
    // the site as its contact, which is where the office looks for whose
    // curtains these are.
    const cust = account
      ? await resolveAccountCustomer(token, sb, account, preview, approved?.customer)
      : await resolveCustomer(token, sb, job, customer, preview, approved?.customer);
    const st = await resolveSite(token, sb, job, site, customer, preview, approved?.site);

    if (preview) {
      return json({
        ok: true,
        preview: true,
        // Anything already linked was approved once before; only first contact
        // with a customer or a site is worth interrupting someone for. A site
        // that collided with somebody else's record always interrupts.
        needs_confirmation: !cust.wasLinked || !st.wasLinked || !!st.conflict,
        account: account ? { name: account.name, reference: job.account_reference || null } : null,
        customer: {
          was_linked: cust.wasLinked, will_create: cust.created,
          fergus_id: cust.id, name: cust.name, contacts: cust.contacts,
          is_account: !!account,
        },
        site: {
          was_linked: st.wasLinked, will_create: st.created,
          fergus_id: st.id, address: st.address, contact: st.contact,
          // Set when the building matched but the record on it belongs to
          // somebody else. The job gets its own site unless a person overrides,
          // which is what conflict_fergus_id is for — offered, never taken by
          // default.
          conflict: st.conflict || null,
          conflict_fergus_id: st.conflictId || null,
          conflict_address: st.conflictAddress || '',
        },
      });
    }

    // The job card is generated by Drapr at acceptance. It's the exact text that
    // used to be copied and pasted into Fergus by hand, and on an account job it
    // already carries the account and their reference at the top.
    const card = job.data?.technician_card?.text
      || [
          account ? `Account: ${account.name}` : null,
          account && job.account_reference
            ? `${account.reference_label || 'Their reference'}: ${job.account_reference}` : null,
          job.customer_name,
          job.site_address,
        ].filter(Boolean).join('\n');

    const body: any = {
      jobType: 'Charge Up',
      title: jobTitle(job),
      description: card,
      customerId: cust.id,
      siteId: st.id,
      isDraft: false,
    };
    // The account's own docket number is what their accounts payable matches an
    // invoice on, so it outranks our PO field and our quote number.
    const ref = job.account_reference || job.data?.po_number || job.quote_number;
    if (ref) body.customerReference = String(ref);

    const created = unwrap(await fergus(token, '/jobs', { method: 'POST', body: JSON.stringify(body) }));
    const fergusJobId = Number(created?.id);
    const fergusJobNo = created?.jobNumber || (created?.jobNo ? `DRD-${created.jobNo}` : null);

    if (!fergusJobId) throw new Error('Fergus did not return a job id');

    // The same job card also goes into the Fergus job notes, pinned, because
    // that is where the office looks rather than the job description.
    // A note failing is not worth failing the push over — the job exists and
    // carries the same text already.
    let noteAdded = false;
    try {
      await fergus(token, '/notes', {
        method: 'POST',
        body: JSON.stringify({
          text: card,
          entityName: 'job',
          entityId: fergusJobId,
          isPinned: true,
          parentId: null,
        }),
      });
      noteAdded = true;
    } catch (_) {
      noteAdded = false;
    }

    const patch: any = {
      fergus_job_id: fergusJobId,
      fergus_job_no: fergusJobNo,
      fergus_synced_at: new Date().toISOString(),
    };
    // drd_number is what the whole Drapr interface already displays.
    if (fergusJobNo && !job.drd_number) patch.drd_number = fergusJobNo;

    // Keep a record of which Fergus records this job was attached to and whether
    // a person chose them. Without it a wrong match leaves no trace of how it
    // was arrived at, which is what made the last one hard to unpick.
    patch.data = {
      ...(job.data || {}),
      fergus_push: {
        at: new Date().toISOString(),
        customer_id: cust.id,
        customer_created: cust.created,
        customer_is_account: !!account,
        account_id: account?.id || null,
        site_id: st.id,
        site_created: st.created,
        site_conflict: st.conflict || null,
        approved: approved
          ? { customer: approved.customer || null, site: approved.site || null }
          : null,
      },
    };

    const { error: upErr } = await sb.from('jobs').update(patch).eq('id', jobId);
    if (upErr) {
      // The Fergus job exists — say so rather than let Drapr retry and duplicate it.
      return json({
        ok: false,
        code: 'writeback_failed',
        error: `Fergus job ${fergusJobNo} was created but Drapr could not be updated: ${upErr.message}`,
        fergus_job_id: fergusJobId,
        fergus_job_no: fergusJobNo,
      }, 500);
    }

    return json({
      ok: true,
      created: true,
      fergus_job_id: fergusJobId,
      fergus_job_no: fergusJobNo,
      customer_created: cust.created,
      site_created: st.created,
      site_conflict: st.conflict || null,
      note_added: noteAdded,
    });
  } catch (err: any) {
    if (err?.code === 'ambiguous_customer') {
      return json({ ok: false, code: err.code, error: err.message, candidates: err.candidates }, 409);
    }
    const status = err instanceof FergusError && err.status === 401 ? 401 : 500;
    return json({
      ok: false,
      code: err instanceof FergusError ? 'fergus_error' : 'error',
      error: err?.message || 'Unknown error',
      detail: err instanceof FergusError ? err.body : undefined,
    }, status);
  }
});
