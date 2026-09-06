const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const ComplianceReportLog = require('../models/ComplianceReportLog');
const { setupClientFolders, renameClientFolders } = require('../services/clientFolderSetupService');
const { deleteClientFolders } = require('../services/clientFolderCleanupService');
const { syncLegacyRulesForClient, deleteAllRulesForClient } = require('../services/matchingRuleSyncService');
const { listPayrollFiles, listAllFilesInFolder } = require('../services/dropboxService');
const {
  findClientsSharingFolders,
  loadFolderIdentitySettings,
  dropboxFolderKey,
  shareFileFolderKey,
} = require('../utils/clientFolderIdentity');
const { normalizeClientMatchingRules } = require('../utils/matchValue');


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

// Blocks a whole-public-domain match from either field: the domains array, or an
// email-addresses entry that is really the domain form ("@gmail.com" / "gmail.com").
// An exact address (bob@gmail.com) normalizes to "bob@gmail.com" and is allowed.
const findBlockedPublicDomain = (matchingRules) => {
  const candidates = [
    ...(matchingRules?.domains || []),
    ...(matchingRules?.emailAddresses || []),
  ].map((value) => normalizeDomainForBlockCheck(value));
  return candidates.find((value) => BLOCKED_PUBLIC_EMAIL_DOMAINS.has(value)) || null;
};


const PATH_GUARD_FIELDS = [
  'name',
  'dropboxPath',
  'shareFilePath',
  'dropboxPathIsAbsolute',
  'shareFilePathIsAbsolute',
];

// Returns the other clients whose Dropbox and/or ShareFile folder resolves to the
// same canonical location as `candidateClient`. Paths that differ only by
// formatting (absolute vs relative, root prefix, slashes, case) still count as
// the same folder — this is what closes the silent-merge bypass.
const findSharedFolderCollisions = async (candidateClient, excludeId) => {
  const settings = await loadFolderIdentitySettings();
  const others = await Client.find(excludeId ? { _id: { $ne: excludeId } } : {})
    .select('name dropboxPath dropboxPathIsAbsolute shareFilePath shareFilePathIsAbsolute')
    .lean();

  const subject = { ...candidateClient, _id: excludeId || null };
  const { dropbox, shareFile } = findClientsSharingFolders(subject, others, settings);

  const collisions = [];
  dropbox.forEach((other) =>
    collisions.push({
      type: 'Dropbox',
      clientId: String(other._id),
      clientName: other.name,
      canonicalPath: dropboxFolderKey(other, settings.dropboxRootPath),
    })
  );
  shareFile.forEach((other) =>
    collisions.push({
      type: 'ShareFile',
      clientId: String(other._id),
      clientName: other.name,
      canonicalPath: shareFileFolderKey(other, settings.shareFileRootPath),
    })
  );
  return collisions;
};

const sendSharedFolderConflict = (res, collisions) => {
  const detail = collisions
    .map((collision) => `the ${collision.type} folder is already used by client "${collision.clientName}"`)
    .join('; ');
  return res.status(409).json({
    error: 'shared_folder_path',
    message:
      `This path collides with another client: ${detail}. Files from both clients would land in the same folder. ` +
      'Pick a different path, or confirm to keep the folder shared.',
    collisions,
  });
};


exports.createClient = async (req, res, next) => {
  try {
    const { allowSharedPath, ...clientData } = req.body;
    if (clientData.matchingRules !== undefined) {
      clientData.matchingRules = normalizeClientMatchingRules(clientData.matchingRules);
    }
    const { name, matchingRules } = clientData;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
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

    if (allowSharedPath !== true) {
      const collisions = await findSharedFolderCollisions(clientData, null);
      if (collisions.length > 0) {
        return sendSharedFolderConflict(res, collisions);
      }
    }

    const client = await Client.create(clientData);

    client.folderSetupWarnings = await setupClientFolders(client);
    await client.save();
    await syncLegacyRulesForClient(client);

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
    const { allowSharedPath, ...clientData } = req.body;
    if (clientData.matchingRules !== undefined) {
      clientData.matchingRules = normalizeClientMatchingRules(clientData.matchingRules);
    }

    if (clientData.name !== undefined) {
      if (!String(clientData.name).trim()) {
        return res.status(400).json({ error: 'name is required' });
      }
      const duplicate = await findDuplicateByName(clientData.name, req.params.id);
      if (duplicate) {
        return res.status(409).json({ error: 'A client with this name already exists' });
      }
    }

    if (clientData.matchingRules !== undefined) {
      const blockedDomain = findBlockedPublicDomain(clientData.matchingRules);
      if (blockedDomain) {
        return res.status(400).json({
          error: `"${blockedDomain}" is a public email provider and cannot be used as a matching domain. Add the specific email address instead.`,
        });
      }
    }


    const beforeUpdate = await Client.findById(req.params.id);
    if (!beforeUpdate) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const touchesPathFields = PATH_GUARD_FIELDS.some((field) => field in clientData);
    if (touchesPathFields && allowSharedPath !== true) {
      const candidate = {
        name: clientData.name ?? beforeUpdate.name,
        dropboxPath: clientData.dropboxPath ?? beforeUpdate.dropboxPath,
        dropboxPathIsAbsolute: clientData.dropboxPathIsAbsolute ?? beforeUpdate.dropboxPathIsAbsolute,
        shareFilePath: clientData.shareFilePath ?? beforeUpdate.shareFilePath,
        shareFilePathIsAbsolute: clientData.shareFilePathIsAbsolute ?? beforeUpdate.shareFilePathIsAbsolute,
      };
      const collisions = await findSharedFolderCollisions(candidate, req.params.id);
      if (collisions.length > 0) {
        return sendSharedFolderConflict(res, collisions);
      }
    }

    const client = await Client.findByIdAndUpdate(req.params.id, clientData, {
      new: true,
      runValidators: true,
    });

    const pathAffectingFieldsChanged =
      (clientData.dropboxPath !== undefined && clientData.dropboxPath.trim() !== (beforeUpdate.dropboxPath || '')) ||
      (clientData.shareFilePath !== undefined && clientData.shareFilePath.trim() !== (beforeUpdate.shareFilePath || '')) ||
      (clientData.dropboxPathIsAbsolute !== undefined &&
        Boolean(clientData.dropboxPathIsAbsolute) !== Boolean(beforeUpdate.dropboxPathIsAbsolute)) ||
      (clientData.shareFilePathIsAbsolute !== undefined &&
        Boolean(clientData.shareFilePathIsAbsolute) !== Boolean(beforeUpdate.shareFilePathIsAbsolute)) ||
      (clientData.name !== undefined && clientData.name.trim() !== beforeUpdate.name);

    if (pathAffectingFieldsChanged) {
      const renameWarnings = await renameClientFolders(beforeUpdate, client);
      const setupWarnings = await setupClientFolders(client);
      client.folderSetupWarnings = [...renameWarnings, ...setupWarnings];
      client.folderSetupRetry = { attempts: 0, lastAttemptAt: null, exhausted: false };
      await client.save();
    }

    if (clientData.matchingRules !== undefined) {
      await syncLegacyRulesForClient(client);
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
    client.folderSetupRetry = { attempts: 0, lastAttemptAt: null, exhausted: false };
    await client.save();

    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
};


exports.getPayrollFiles = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!client.dropboxPath) {
      return res.status(200).json({ files: [] });
    }

    const files = await listPayrollFiles(client.dropboxPath, client.dropboxPathIsAbsolute);
    res.status(200).json({ files });
  } catch (error) {
    next(error);
  }
};

exports.getClientFolderFiles = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    if (!client.dropboxPath) {
      return res.status(200).json({ files: [] });
    }

    const files = await listAllFilesInFolder(client.dropboxPath, client.dropboxPathIsAbsolute);
    res.status(200).json({ files });
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
    await deleteAllRulesForClient(req.params.id);
    res.status(200).json({ message: 'Client deleted successfully', folderWarnings });
  } catch (error) {
    next(error);
  }
};
