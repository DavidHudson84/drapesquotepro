process.env.TZ = 'Australia/Melbourne';
const seed = require('./seed-base');
seed.tables.enquiries = require('./seed-enq')(seed.CID);
Object.assign(seed.tables, require('./seed-jobs')(seed.CID));
module.exports = seed;
