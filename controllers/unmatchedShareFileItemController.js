const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { uploadFileToDropbox } = require('../services/dropboxService');
const { downloadFileContentById } = require('../services/sharefileService');
const { formatError } = require('../utils/formatError');

const normalizeForMatch = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const attachSuggestedClient = (items, clients) => {
  const normalizedClients = clients.map((client) => ({
    client,
    norm: normalizeForMatch(client.name),
  }));

  return items.map((item) => {
    const itemNorm = normalizeForMatch(item.name);
    const match = itemNorm
      ? normalizedClients.find(({ norm }) => norm && (norm.includes(itemNorm) || itemNorm.includes(norm)))
      : null;
    return { ...item, suggestedClientId: match ? match.client : null };
  });
};

exports.getAllUnmatchedItems = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { status: 'unresolved' };
    const [items, clients] = await Promise.all([
      UnmatchedShareFileItem.find(filter).sort({ discoveredAt: -1 }).populate('resolvedClientId').lean(),
      Client.find().select('name').lean(),
    ]);
    res.status(200).json(attachSuggestedClient(items, clients));
  } catch (error) {
    next(error);
  }
};

const resolveOneUnmatchedItem = async (item, client) => {
  if (item.status !== 'unresolved') {
    return { error: `This item is already ${item.status}, not unresolved.` };
  }

  try {
    const content = await downloadFileContentById(item.itemId);
    const dropboxPath = await uploadFileToDropbox(
      client.dropboxPath || client.name,
      item.name,
      content,
      undefined,
      client.dropboxPathIsAbsolute
    );

    await FileLog.findOneAndUpdate(
      { source: 'sharefile', sourceFileId: item.itemId, clientId: client._id },
      {
        $set: {
          source: 'sharefile',
          sourceFileId: item.itemId,
          clientId: client._id,
          originalName: item.name,
          destinationPath: dropboxPath,
          destination: 'dropbox',
          status: 'moved',
          processedAt: new Date(),
          sourceCreatedAt: item.sourceCreatedAt || null,
          matchMethod: 'manual',
        },
        $unset: { errorMessage: 1 },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  } catch (error) {
    console.error(`resolveOneUnmatchedItem: could not save file "${item.name}" - ${formatError(error)}`);
    return { error: `Could not save this file to Dropbox: ${formatError(error)}` };
  }

  item.status = 'resolved';
  item.resolvedClientId = client._id;
  item.resolvedAt = new Date();
  await item.save();
  return { error: null };
};

exports.resolveUnmatchedItem = async (req, res, next) => {
  try {
    const { clientId } = req.body;
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const item = await UnmatchedShareFileItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Unmatched item not found' });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const { error } = await resolveOneUnmatchedItem(item, client);
    if (error) {
      return res.status(400).json({ error });
    }

    const updated = await UnmatchedShareFileItem.findById(item._id).populate('resolvedClientId');
    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

exports.bulkResolveUnmatchedItems = async (req, res, next) => {
  try {
    const { itemIds, clientId } = req.body;
    if (!Array.isArray(itemIds) || itemIds.length === 0) {
      return res.status(400).json({ error: 'itemIds must be a non-empty array' });
    }
    if (!clientId) {
      return res.status(400).json({ error: 'clientId is required' });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const results = [];
    for (const itemId of itemIds) {
      const item = await UnmatchedShareFileItem.findById(itemId);
      if (!item) {
        results.push({ itemId, success: false, error: 'Unmatched item not found' });
        continue;
      }

      const { error } = await resolveOneUnmatchedItem(item, client);
      results.push({ itemId, success: !error, error: error || undefined });
    }

    const succeeded = results.filter((result) => result.success).length;
    res.status(200).json({ succeeded, failed: results.length - succeeded, results });
  } catch (error) {
    next(error);
  }
};

exports.dismissUnmatchedItem = async (req, res, next) => {
  try {
    const item = await UnmatchedShareFileItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Unmatched item not found' });
    }
    if (item.status !== 'unresolved') {
      return res.status(400).json({ error: `This item is already ${item.status}, not unresolved.` });
    }

    item.status = 'dismissed';
    await item.save();
    res.status(200).json(item);
  } catch (error) {
    next(error);
  }
};

exports.restoreUnmatchedItem = async (req, res, next) => {
  try {
    const item = await UnmatchedShareFileItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Unmatched item not found' });
    }
    if (item.status !== 'dismissed') {
      return res.status(400).json({ error: `This item is ${item.status}, not dismissed.` });
    }

    item.status = 'unresolved';
    await item.save();
    res.status(200).json(item);
  } catch (error) {
    next(error);
  }
};

exports.deleteUnmatchedItem = async (req, res, next) => {
  try {
    const item = await UnmatchedShareFileItem.findByIdAndDelete(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Unmatched item not found' });
    }
    res.status(200).json({ message: 'Removed from the review list.' });
  } catch (error) {
    next(error);
  }
};
