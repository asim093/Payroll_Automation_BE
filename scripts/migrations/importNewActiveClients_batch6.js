const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');

// new_active_clients_6.csv, with dropboxPath already verified live against
// Dropbox (see chat) — every one of these 6 has a real top-level folder and
// a "Payroll Files" subfolder, so every dropboxPath below is "{Name}/Payroll Files".
const NEW_CLIENTS = [
  {
    name: 'Balanced Diversity LLC',
    fein: '39-3151601',
    wotcFormUrl: '',
    emailSalutation: 'Liliana',
    complianceReportEmailDistribution: 'liliana@balancestaffing.com',
    matchingEmails: ['liliana@balancestaffing.com'],
    matchingDomains: ['balancestaffing.com'],
    dropboxPath: 'Balanced Diversity LLC/Payroll Files',
  },
  {
    name: 'Massage JMSRx, Inc',
    fein: '82-1103147',
    wotcFormUrl: '',
    emailSalutation: 'Joe',
    complianceReportEmailDistribution: 'joe.szablewski@massageenvy.com',
    matchingEmails: ['joe.szablewski@massageenvy.com'],
    matchingDomains: ['massageenvy.com'],
    dropboxPath: 'Massage JMSRx, Inc/Payroll Files',
  },
  {
    name: 'ME Northeast LLC',
    fein: '87-1320217',
    wotcFormUrl: '',
    emailSalutation: 'Joe',
    complianceReportEmailDistribution: 'joe.szablewski@massageenvy.com',
    matchingEmails: ['joe.szablewski@massageenvy.com'],
    matchingDomains: ['massageenvy.com'],
    dropboxPath: 'ME Northeast LLC/Payroll Files',
  },
  {
    name: 'Right At Home - Genesee',
    fein: '85-4237218',
    wotcFormUrl: '',
    emailSalutation: 'Scott',
    complianceReportEmailDistribution: 'shill@rahcare.net',
    matchingEmails: ['shill@rahcare.net'],
    matchingDomains: ['rahcare.net'],
    dropboxPath: 'Right At Home - Genesee/Payroll Files',
  },
  {
    name: 'TradeSTAR Inc',
    fein: '20-1144343',
    wotcFormUrl: 'https://forms.mja-associates.com/wotc/?EMPLOYERUUID=718EDB4A-FC6D-4D4A-B9D0-9AA2268B231A',
    emailSalutation: 'Larry and Traci',
    complianceReportEmailDistribution: 'pierce@tradestarinc.com; tsedtal@tradestarinc.com',
    matchingEmails: ['pierce@tradestarinc.com'],
    matchingDomains: ['tradestarinc.com'],
    dropboxPath: 'TradeSTAR Inc/Payroll Files',
  },
  {
    name: 'X3 Industrial LLC',
    fein: '33-4192267',
    wotcFormUrl: '',
    emailSalutation: 'Lindsay',
    complianceReportEmailDistribution: 'lindsay@x3tradesmen.com',
    matchingEmails: ['lindsay@x3tradesmen.com'],
    matchingDomains: ['x3tradesmen.com'],
    dropboxPath: 'X3 Industrial LLC/Payroll Files',
  },
];

(async () => {
  try {
    await connectDB();
    const created = [];
    const skipped = [];

    for (const row of NEW_CLIENTS) {
      const existing = await Client.findOne({ name: row.name }).collation({ locale: 'en', strength: 2 });
      if (existing) {
        skipped.push(row.name);
        console.log(`${row.name} | SKIPPED (already exists, id ${existing._id})`);
        continue;
      }

      const clientDoc = new Client({
        name: row.name,
        status: 'inactive',
        dropboxPath: row.dropboxPath,
        dropboxPathIsAbsolute: false,
        fein: row.fein,
        wotcFormUrl: row.wotcFormUrl,
        emailSalutation: row.emailSalutation,
        complianceReportEmailDistribution: row.complianceReportEmailDistribution,
        matchingRules: {
          emailAddresses: row.matchingEmails,
          domains: row.matchingDomains,
        },
      });
      await clientDoc.save();
      created.push(clientDoc);
      console.log(`${row.name} | CREATED | id=${clientDoc._id} | dropboxPath="${row.dropboxPath}" | wotcFormUrl="${row.wotcFormUrl}"`);
    }

    console.log(`\nCreated: ${created.length}, Skipped: ${skipped.length}`);
  } catch (error) {
    console.error('FATAL ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
})();
