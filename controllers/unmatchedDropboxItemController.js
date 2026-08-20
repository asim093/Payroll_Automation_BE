const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { moveDropboxItemToClientFolder, deleteDropboxItemByPath } = require('../services/dropboxService');
const { formatError } = require('../utils/formatError');

// Dropbox counterpart of controllers/unmatchedShareFileItemController.js —
// same three actions (resolve/dismiss/delete), same semantics, adapted for
// Dropbox being the SYSTEM'S FINAL destination rather than a source (see
// services/dropboxService.js's scan function for why there's no per-client
// mismatch-walk here).

// @desc    List unmatched Dropbox items (unresolved by default - pass
//          ?all=true for resolved/dismissed ones too).
// @route   GET /api/unmatched-dropbox-items
exports.getAllUnmatchedItems = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { status: 'unresolved' };
    const items = await UnmatchedDropboxItem.find(filter).sort({ discoveredAt: -1 }).populate('resolvedClientId');
    res.status(200).json(items);
  } catch (error) {
    next(error);
  }
};

// @desc    Resolve an unmatched item by assigning it to a client.
//          - "folder" items: the folder's own name becomes that client's
//            dropboxPath going forward - no files are moved, this just
//            corrects where our system looks from now on.
//          - "file" items: moved (not copied - it's already in Dropbox,
//            just in the wrong place) into the client's proper Dropbox
//            folder, and logged in FileLog.
// @route   PATCH /api/unmatched-dropbox-items/:id/resolve
// @body    { clientId }
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

// @desc    Dismiss an unmatched item (e.g. it's a legitimate non-client
//          folder like "Templates") so it stops being flagged on every
//          future scan, without assigning it to any client.
// @route   PATCH /api/unmatched-dropbox-items/:id/dismiss
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

// @desc    Permanently delete an unmatched folder from Dropbox itself (not
//          just dismiss the flag) - only ever offered for EMPTY folders
//          (see UnmatchedDropboxItem.isEmpty). Refuses to run on anything
//          else, since deleting a non-empty folder or a loose file would
//          destroy real content this endpoint was never meant to touch.
// @route   DELETE /api/unmatched-dropbox-items/:id
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
