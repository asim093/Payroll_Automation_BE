const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { moveDropboxItemToClientFolder, deleteDropboxItemByPath } = require('../services/dropboxService');
const { formatError } = require('../utils/formatError');

exports.getAllUnmatchedItems = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { status: 'unresolved' };
    const items = await UnmatchedDropboxItem.find(filter).sort({ discoveredAt: -1 }).populate('resolvedClientId');
    res.status(200).json(items);
  } catch (error) {
    next(error);
  }
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
    if (item.status !== 'unresolved') {
      return res.status(400).json({ error: `This item is already ${item.status}, not unresolved.` });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (item.itemType === 'folder') {
      client.dropboxPath = item.name;
      await client.save();
    } else {
      try {
        const newPath = await moveDropboxItemToClientFolder(item.path, client.dropboxPath || client.name, item.name);

        await FileLog.create({
          source: 'dropbox',
          sourceFileId: item.itemId,
          clientId: client._id,
          originalName: item.name,
          destinationPath: newPath,
          destination: 'dropbox',
          status: 'moved',
          processedAt: new Date(),
        });
      } catch (error) {
        console.error(`resolveUnmatchedItem (dropbox): could not move "${item.name}" - ${formatError(error)}`);
        return res.status(502).json({ error: `Could not move this file: ${formatError(error)}` });
      }
    }

    item.status = 'resolved';
    item.resolvedClientId = client._id;
    item.resolvedAt = new Date();
    await item.save();

    const updated = await UnmatchedDropboxItem.findById(item._id).populate('resolvedClientId');
    res.status(200).json(updated);
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
