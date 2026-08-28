const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { setupClientFolders } = require('../services/clientFolderSetupService');
const { deleteClientFolders } = require('../services/clientFolderCleanupService');


const normalizeForMatch = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');


const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


const findDuplicateByName = async (name, excludeId) => {
  const trimmedName = String(name).trim();
  const query = { name: new RegExp(`^${escapeRegExp(trimmedName)}$`, 'i') };
  if (excludeId) {
    query._id = { $ne: excludeId };
  }
  return Client.findOne(query);
};



const BLOCKED_PUBLIC_EMAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'aol.com',
  'icloud.com',
  'me.com',
  'protonmail.com',
]);

const normalizeDomainForBlockCheck = (value) =>
  String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];

const findBlockedPublicDomain = (matchingRules) => {
  const domains = (matchingRules?.domains || []).map((domain) => normalizeDomainForBlockCheck(domain));
  return domains.find((domain) => BLOCKED_PUBLIC_EMAIL_DOMAINS.has(domain)) || null;
};


const findMatchingRuleConflict = async (matchingRules, excludeId) => {
  const emails = (matchingRules?.emailAddresses || []).map((email) => String(email).trim().toLowerCase()).filter(Boolean);
  const domains = (matchingRules?.domains || []).map((domain) => String(domain).trim().toLowerCase()).filter(Boolean);
  if (emails.length === 0 && domains.length === 0) {
    return null;
  }

  const query = excludeId ? { _id: { $ne: excludeId } } : {};
  const otherClients = await Client.find(query).select('name matchingRules').lean();

  for (const other of otherClients) {
    const otherEmails = (other.matchingRules?.emailAddresses || []).map((email) => String(email).trim().toLowerCase());
    const otherDomains = (other.matchingRules?.domains || []).map((domain) => String(domain).trim().toLowerCase());

    const emailConflict = emails.find((email) => otherEmails.includes(email));
    if (emailConflict) {
      return `Email address "${emailConflict}" is already used by client "${other.name}"`;
    }

    const domainConflict = domains.find((domain) => otherDomains.includes(domain));
    if (domainConflict) {
      return `Domain "${domainConflict}" is already used by client "${other.name}"`;
    }
  }

  return null;
};


exports.createClient = async (req, res, next) => {
  try {
    const { name, matchingRules } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const emailAddresses = matchingRules?.emailAddresses || [];
    const domains = matchingRules?.domains || [];
    if (emailAddresses.length === 0 && domains.length === 0) {
      return res.status(400).json({
        error: 'At least one matchingRules.emailAddresses or matchingRules.domains entry is required',
      });
    }

    const duplicate = await findDuplicateByName(name);
    if (duplicate) {
      return res.status(409).json({ error: 'A client with this name already exists' });
    }

    const blockedDomain = findBlockedPublicDomain(matchingRules);
    if (blockedDomain) {
      return res.status(400).json({
        error: `"${blockedDomain}" is a public email provider and cannot be used as a matching domain. Add the specific email address instead.`,
      });
    }

    const ruleConflict = await findMatchingRuleConflict(matchingRules);
    if (ruleConflict) {
      return res.status(409).json({ error: ruleConflict });
    }

    const client = await Client.create(req.body);

    client.folderSetupWarnings = await setupClientFolders(client);
    await client.save();

    res.status(201).json(client);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A client with this name already exists' });
    }
    next(error);
  }
};


exports.getAllClients = async (req, res, next) => {
  try {
    const clients = await Client.find().lean();
    res.status(200).json(clients);
  } catch (error) {
    next(error);
  }
};


exports.getClientsWithLastActivity = async (req, res, next) => {
  try {
    const clients = await Client.find().sort({ name: 1 }).lean();

    const [emailActivity, fileActivity] = await Promise.all([
      EmailLog.aggregate([
        { $match: { matchedClientId: { $ne: null } } },
        { $group: { _id: '$matchedClientId', lastAt: { $max: '$receivedAt' } } },
      ]),
      FileLog.aggregate([
        { $match: { clientId: { $ne: null } } },
        { $group: { _id: '$clientId', lastAt: { $max: '$processedAt' } } },
      ]),
    ]);

    const emailMap = new Map(emailActivity.map((row) => [String(row._id), row.lastAt]));
    const fileMap = new Map(fileActivity.map((row) => [String(row._id), row.lastAt]));

    const enriched = clients.map((client) => {
      const emailDate = emailMap.get(String(client._id));
      const fileDate = fileMap.get(String(client._id));

      let lastActivity = null;
      if (emailDate && fileDate) {
        lastActivity = new Date(emailDate) > new Date(fileDate) ? emailDate : fileDate;
      } else {
        lastActivity = emailDate || fileDate || null;
      }

      return { ...client, lastActivity };
    });

    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};


exports.getClientHistory = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const [emails, files] = await Promise.all([
      EmailLog.find({ matchedClientId: client._id }).sort({ receivedAt: -1 }).limit(5).lean(),
      FileLog.find({ clientId: client._id }).sort({ processedAt: -1 }).limit(5).lean(),
    ]);

    const history = [
      ...emails.map((email) => ({
        type: 'email',
        date: email.receivedAt,
        sender: email.sender,
        subject: email.subject,
        status: email.status,
      })),
      ...files.map((file) => ({
        type: 'file',
        date: file.processedAt,
        originalName: file.originalName,
        destination: file.destination,
        status: file.status,
      })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);

    res.status(200).json({ client, history });
  } catch (error) {
    next(error);
  }
};


exports.getClientProfile = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const [emailLogs, fileLogs, unmatchedItems, complianceReportLogs] = await Promise.all([
      EmailLog.find({ matchedClientId: client._id }).sort({ receivedAt: -1 }).lean(),
      FileLog.find({ clientId: client._id }).sort({ processedAt: -1 }).lean(),
      UnmatchedShareFileItem.find({ status: 'unresolved' }).lean(),
      ComplianceReportLog.find({ clientId: client._id }).sort({ generatedAt: -1 }).limit(500).lean(),
    ]);

    const lastEmailAt = emailLogs[0]?.receivedAt;
    const lastFileAt = fileLogs[0]?.processedAt;
    let lastProcessedAt = null;
    if (lastEmailAt && lastFileAt) {
      lastProcessedAt = new Date(lastEmailAt) > new Date(lastFileAt) ? lastEmailAt : lastFileAt;
    } else {
      lastProcessedAt = lastEmailAt || lastFileAt || null;
    }

    const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const filesThisWeek = fileLogs.filter((file) => file.processedAt && new Date(file.processedAt) >= oneWeekAgo).length;
    const emailsThisWeek = emailLogs.filter((email) => email.receivedAt && new Date(email.receivedAt) >= oneWeekAgo).length;

    const clientNorm = normalizeForMatch(client.name);
    const suggestedUnmatchedItems = clientNorm
      ? unmatchedItems.filter((item) => {
          const itemNorm = normalizeForMatch(item.name);
          return itemNorm && (itemNorm.includes(clientNorm) || clientNorm.includes(itemNorm));
        })
      : [];

    res.status(200).json({
      client,
      emailLogs,
      fileLogs,
      lastProcessedAt,
      stats: {
        filesThisWeek,
        emailsThisWeek,
        totalFiles: fileLogs.length,
        totalEmails: emailLogs.length,
      },
      suggestedUnmatchedItems,
      complianceReportLogs,
    });
  } catch (error) {
    next(error);
  }
};


exports.getClientById = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
};


exports.updateClient = async (req, res, next) => {
  try {
    if (req.body.name !== undefined) {
      if (!String(req.body.name).trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const duplicate = await findDuplicateByName(req.body.name, req.params.id);
      if (duplicate) {
        return res.status(409).json({ error: 'A client with this name already exists' });
      }
    }

    if (req.body.matchingRules !== undefined) {
      const blockedDomain = findBlockedPublicDomain(req.body.matchingRules);
      if (blockedDomain) {
        return res.status(400).json({
          error: `"${blockedDomain}" is a public email provider and cannot be used as a matching domain. Add the specific email address instead.`,
        });
      }

      const ruleConflict = await findMatchingRuleConflict(req.body.matchingRules, req.params.id);
      if (ruleConflict) {
        return res.status(409).json({ error: ruleConflict });
      }
    }


    const beforeUpdate = await Client.findById(req.params.id);
    if (!beforeUpdate) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const client = await Client.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    const pathAffectingFieldsChanged =
      (req.body.dropboxPath !== undefined && req.body.dropboxPath.trim() !== (beforeUpdate.dropboxPath || '')) ||
      (req.body.shareFilePath !== undefined && req.body.shareFilePath.trim() !== (beforeUpdate.shareFilePath || '')) ||
      (req.body.dropboxPathIsAbsolute !== undefined &&
        Boolean(req.body.dropboxPathIsAbsolute) !== Boolean(beforeUpdate.dropboxPathIsAbsolute)) ||
      (req.body.shareFilePathIsAbsolute !== undefined &&
        Boolean(req.body.shareFilePathIsAbsolute) !== Boolean(beforeUpdate.shareFilePathIsAbsolute)) ||
      (req.body.name !== undefined && req.body.name.trim() !== beforeUpdate.name);

    if (pathAffectingFieldsChanged) {
      client.folderSetupWarnings = await setupClientFolders(client);
      await client.save();
    }

    res.status(200).json(client);
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: 'A client with this name already exists' });
    }
    next(error);
  }
};


exports.retryFolderSetup = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    client.folderSetupWarnings = await setupClientFolders(client);
    await client.save();

    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
};


exports.deleteClient = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    let folderWarnings = [];
    if (req.query.deleteFolders === 'true') {
      folderWarnings = await deleteClientFolders(client);
    }

    await Client.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Client deleted successfully', folderWarnings });
  } catch (error) {
    next(error);
  }
};
