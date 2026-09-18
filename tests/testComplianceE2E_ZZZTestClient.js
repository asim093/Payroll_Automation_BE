const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');

// Monkey-patch logiFormsService BEFORE the orchestrator is required, so the
// orchestrator's own `const { fetchLogiFormsDataForClient } = require(...)`
// destructures our stub off the (already-patched) cached module.exports
// object — no production file is edited on disk.
const logiFormsService = require('../services/logiFormsService');

const FAKE_LOGIFORMS_DATA = [
  { ssn: '000000001', status: 'Certified', dateSubmitted: new Date('2026-08-04') },
  { ssn: '000000002', status: 'Certified', dateSubmitted: new Date('2026-08-06') },
  { ssn: '000000003', status: 'Certified', dateSubmitted: new Date('2026-08-12') },
  // 000000004 and 000000005 intentionally have NO LogiForms record -> Incomplete
];

logiFormsService.fetchLogiFormsDataForClient = async (fein) => {
  console.log(`[STUB] fetchLogiFormsDataForClient called with fein="${fein}" -> returning ${FAKE_LOGIFORMS_DATA.length} fake rows (real ShareFile LogiForms CSV NOT touched).`);
  return FAKE_LOGIFORMS_DATA;
};

const { generateComplianceReportForClient } = require('../services/complianceReportOrchestratorService');

(async () => {
  try {
    await connectDB();

    const client = await Client.findOne({ name: 'ZZZ Test Client' });
    if (!client) throw new Error('ZZZ Test Client not found — run Phase 1 first.');
    console.log(`Found client _id=${client._id}, fein=${client.fein}, dropboxPath="${client.dropboxPath}"`);

    console.log('\n--- Calling real generateComplianceReportForClient(clientId) ---\n');
    const result = await generateComplianceReportForClient(client._id);

    console.log('\n--- ORCHESTRATOR RESULT ---');
    console.log(JSON.stringify(result, null, 2));

    console.log('\n--- ComplianceReportLog documents for this client ---');
    const logs = await ComplianceReportLog.find({ clientId: client._id }).lean();
    console.log(JSON.stringify(logs, null, 2));
  } catch (error) {
    console.error('FATAL ERROR:', error.message, error.stack);
  } finally {
    await mongoose.connection.close();
  }
})();
