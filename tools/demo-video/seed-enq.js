const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.toISOString(); };
const daysAgo = (n, h = 10) => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(h, 12, 0, 0); return d.toISOString(); };
module.exports = (CID) => [
  { id: 'enq-sarah', company_id: CID, quote_number: 'DRQ-2468', customer_name: 'Sarah Mitchell', customer_phone: '0412 555 018',
    customer_email: 'sarah.mitchell@example.com', site_address: '14 Ferguson Street, Williamstown VIC 3016', status: 'new', submitted_at: today(7, 42),
    data: { property_type: 'House', contact_time: 'Mornings', contact_method: 'Phone', customer_rating: 6, observation_ticks: ['mould', 'sun'],
      description: 'Lounge curtains have mould spots along the bottom and the sheers are looking grey. Bedroom blinds just need a clean.',
      rooms: [
        { name: 'Lounge', items: [
          { type: 'curtain', width: '3600', height: '2700', heightMode: 'measure', mould: true, note: 'Pinch pleat, lined' },
          { type: 'sheer', width: '3600', height: '2700', heightMode: 'measure' } ] },
        { name: 'Main bedroom', items: [
          { type: 'roller-block', width: '1200', height: '1800', heightMode: 'measure' },
          { type: 'roller-block', width: '1200', height: '1800', heightMode: 'measure' } ] } ] } },
  { id: 'enq-2', company_id: CID, quote_number: 'DRQ-2466', customer_name: 'James Okafor', customer_phone: '0433 210 777', customer_email: 'j.okafor@example.com',
    site_address: '3/88 Barkly Street, St Kilda VIC 3182', status: 'called', submitted_at: daysAgo(1, 19),
    data: { property_type: 'Apartment', contact_time: 'Evenings', contact_method: 'Email', description: 'Two sets of velvet drapes in the living room, about 4 m tall.',
      rooms: [{ name: 'Living', items: [{ type: 'velvet', width: '2800', heightMode: 'tier', tier: 'tall' }, { type: 'velvet', width: '2800', heightMode: 'tier', tier: 'tall' }] }] } },
  { id: 'enq-3', company_id: CID, quote_number: 'DRQ-2469', customer_name: 'Linda Cheng', customer_phone: '0402 118 342', customer_email: 'linda.cheng@example.com',
    site_address: '27 Rosamond Road, Maribyrnong VIC 3032', status: 'new', submitted_at: today(6, 58),
    data: { property_type: 'House', contact_time: 'Any time', contact_method: 'Phone', observation_ticks: ['smoke'], description: 'Smoke smell through all curtains after a kitchen fire. Insurance claim with Allianz.',
      rooms: [{ name: 'Whole house', items: [{ type: 'unsure', note: 'Around 8 windows' }] }] } },
];
