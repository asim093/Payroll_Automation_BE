const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { moveDropboxItemToClientFolder, deleteDropboxItemByPath } = require('../services/dropboxService');
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
      UnmatchedDropboxItem.find(filter).sort({ discoveredAt: -1 }).populate('resolvedClientId').lean(),
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

  if (item.itemType === 'folder') {
    client.dropboxPath = item.name;
    await client.save();
  } else {
    try {
      const newPath = await moveDropboxItemToClientFolder(
        item.path,
        client.dropboxPath || client.name,
        item.name,
        client.dropboxPathIsAbsolute
      );

      await FileLog.create({
        source: 'dropbox',
        sourceFileId: item.itemId,
        clientId: client._id,
        originalName: item.name,
        destinationPath: newPath,
        destination: 'dropbox',
        status: 'moved',
        processedAt: new Date(),
        matchMethod: 'manual',
      });
    } catch (error) {
      console.error(`resolveOneUnmatchedItem (dropbox): could not move "${item.name}" - ${formatError(error)}`);
      return { error: `Could not move this file: ${formatError(error)}` };
    }
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

    const item = await UnmatchedDropboxItem.findById(req.params.id);
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

    const updated = await UnmatchedDropboxItem.findById(item._id).populate('resolvedClientId');
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
      const item = await UnmatchedDropboxItem.findById(itemId);
      if (!item) {
        results.push({ itemId, success: false, error: 'Unmatched item not found' });
        continue;
      }
      if (item.itemType === 'folder') {
        results.push({
          itemId,
          success: false,
          error: 'Folders can only be assigned one at a time, not in bulk, since each folder belongs to exactly one client.',
        });
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
    const item = await UnmatchedDropboxItem.findById(req.params.id);
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

exports.deleteUnmatchedItem = async (req, res, next) => {
  try {
    const item = await UnmatchedDropboxItem.findById(req.params.id);
    if (!item) {
      return res.status(404).json({ error: 'Unmatched item not found' });
    }
    if (item.status !== 'unresolved') {
      return res.status(400).json({ error: `This item is already ${item.status}, not unresolved.` });
    }
    if (item.itemType !== 'folder' || !item.isEmpty) {
      return res.status(400).json({
        error: 'Only empty folders can be deleted here. Assign or dismiss this item instead.',
      });
    }

    try {
      await deleteDropboxItemByPath(item.path);
    } catch (error) {
      console.error(`deleteUnmatchedItem (dropbox): could not delete "${item.path}" - ${formatError(error)}`);
      return res.status(502).json({ error: `Could not delete this folder from Dropbox: ${formatError(error)}` });
    }

    item.status = 'dismissed';
    item.resolvedAt = new Date();
    await item.save();
    res.status(200).json(item);
  } catch (error) {
    next(error);
  }
};
