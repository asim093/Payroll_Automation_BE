const Client = require('../models/Client');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { generateComplianceReportsForMultipleClients } = require('../services/complianceReportOrchestratorService');

const generateReports = async (req, res) => {
  const { clientIds } = req.body || {};

  if (!Array.isArray(clientIds) || clientIds.length === 0) {
    return res.status(400).json({ error: 'clientIds must be a non-empty array' });
  }

  res.json({ success: true, message: 'Processing started' });

  generateComplianceReportsForMultipleClients(clientIds).catch((error) => {
    console.error(`[COMPLIANCE-REPORTS] generateComplianceReportsForMultipleClients rejected unexpectedly: ${error.message}`);
  });
};

const getComplianceReportStatus = async (req, res, next) => {
  try {
    const clients = await Client.find({ status: 'active' })
      .select('name fein complianceReportEmailDistribution')
      .sort({ name: 1 })
      .lean();

    const clientIds = clients.map((client) => client._id);
    const logs = await ComplianceReportLog.find({ clientId: { $in: clientIds } })
      .sort({ generatedAt: -1 })
      .lean();

    const lastLogByClientId = new Map();
    for (const log of logs) {
      const key = String(log.clientId);
      if (!lastLogByClientId.has(key)) {
        lastLogByClientId.set(key, log);
      }
    }

    const result = clients.map((client) => ({
      ...client,
      lastReport: lastLogByClientId.get(String(client._id)) || null,
    }));

    res.json(result);
  } catch (error) {
    next(error);
  }
};

module.exports = { generateReports, getComplianceReportStatus };
