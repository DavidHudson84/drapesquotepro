// Base seed: company, staff login, price list, accounts. Jobs are added by
// driving the app itself (seed-run), so their data has exactly the app's shape.
const CID = 'demo-company';
const rates = {
  'curtain-s': 38, 'curtain-m': 44, 'curtain-l': 52,
  'sheer-s': 30, 'sheer-l': 36,
  'velvet-s': 56, 'velvet-m': 64, 'velvet-l': 74,
  roman: 42, austrian: 48, 'roller-sun': 28, 'roller-block': 30, venetian: 34,
  pelmet: 30, swags: 45, valance: 32,
  mould: 12, 'mould-blind': 9,
  'cord-replace': 25, 'cord-tidy': 15, 'hook-replace': 2.5, 'ring-replace': 3, 'weight-replace': 6,
  'track-repair': 45, 'track-replace': 120, 'motor-service': 85, 'motor-replace': 260,
  'lining-repair': 40, 'heading-repair': 35, 'seam-repair': 30, 'bracket-replace': 18, 'wand-replace': 15, 'fascia-repair': 40,
};
const settings = Object.entries(rates).map(([key, value]) => ({ company_id: CID, key, value: String(value) }));
const more = {
  'target-quoted': 60000, 'target-confirmed': 35000, 'target-invoiced': 30000, 'target-newjobs': 70,
  'followup-days-1': 10, 'followup-days-2': 21, 'followup-days-3': 35,
  'google-review-link': 'https://g.page/r/demo',
  'staff-names': 'Sam, Priya, Tom, Mel',
  'storage-locations': 'Rack A, Rack B, Rack C, Blind rack, Hanging bay',
  'terms-text': 'Quotes are valid for 30 days. Payment is due on completion. Curtains are cleaned at the owner\'s risk where fabric is weakened by sun or age; any such risk is noted at pre-inspection.',
  'portal-base-url': 'http://localhost:8790/',
};
Object.entries(more).forEach(([key, value]) => settings.push({ company_id: CID, key, value: String(value) }));

module.exports = {
  CID,
  user: { id: 'demo-user', email: 'sam@brightdrapes.com.au' },
  tables: {
    companies: [{ id: CID, name: 'Dr Drapes Curtain Clinic', slug: 'dr-drapes', logo_url: null, primary_colour: '#0F6E63',
      contact_email: 'drdrapes@hudsongroup.com.au', contact_phone: '1300 652 866', address: '12 Demo Way, Footscray VIC 3011', plan: 'pro' }],
    app_users: [
      { id: 'demo-user', company_id: CID, name: 'Sam Carter', role: 'admin', email: 'sam@brightdrapes.com.au', active: true, fergus_user_id: null },
      { id: 'demo-driver', company_id: CID, name: 'Tom Nguyen', role: 'driver', email: 'tom@brightdrapes.com.au', active: true, fergus_user_id: 501 },
    ],
    settings,
    accounts: [
      { id: 'acc-steam', company_id: CID, name: 'Rapid Restore Group', kind: 'trade', reference_label: 'Job number', reference_required: true, active: true, group_name: null },
      { id: 'acc-dry', company_id: CID, name: 'Kensington Dry Cleaners', kind: 'trade', reference_label: 'Docket number', reference_required: false, active: true, group_name: null },
      { id: 'acc-aged', company_id: CID, name: 'Parkview Aged Care', kind: 'commercial', reference_label: 'PO number', reference_required: false, active: true, group_name: null },
      { id: 'acc-hotel', company_id: CID, name: 'The Harbour Hotel', kind: 'commercial', reference_label: 'PO number', reference_required: false, active: true, group_name: null },
    ],
    customers: [], sites: [], jobs: [], enquiries: [], price_history: [], partner_users: [], receptionist_calls: [],
    run_sheet_stops: [], schedule_stops: [],
  },
};
