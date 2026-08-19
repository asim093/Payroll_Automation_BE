const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const { uploadFileToDropbox } = require('../services/dropboxService');
const { downloadFileContentById } = require('../services/sharefileService');
const { formatError } = require('../utils/formatError');

// @desc    List unmatched ShareFile items (unresolved by default - pass
//          ?all=true for resolved/dismissed ones too, same convention as
//          GET /api/review-queue).
// @route   GET /api/unmatched-sharefile-items
exports.getAllUnmatchedItems = async (req, res, next) => {
  try {
    const filter = req.query.all === 'true' ? {} : { status: 'unresolved' };
    const items = await UnmatchedShareFileItem.find(filter).sort({ discoveredAt: -1 }).populate('resolvedClientId');
    res.status(200).json(items);
  } catch (error) {
    next(error);
  }
};

// @desc    Resolve an unmatched item by assigning it to a client.
//          - "folder" items: the folder's own name becomes that client's
//            shareFilePath going forward (this is a NEW top-level folder
//            found sitting directly under the ShareFile root, so its name
//            IS the client's full ShareFile path from here on) - no files
//            are moved or copied, this just corrects where our system looks
//            from now on. The regular per-client scan will pick up
//            whatever's already inside it on its next cycle.
//          - "file" items: downloaded from ShareFile and saved to Dropbox
//            immediately (same pipeline processShareFileScan.js uses for
//            already-known files), since a loose file has no "folder" to
//            just start recognizing - it has to actually be filed somewhere.
// @route   PATCH /api/unmatched-sharefile-items/:id/resolve
// @body    { clientId }
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
    if (item.status !== 'unresolved') {
      return res.status(400).json({ error: `This item is already ${item.status}, not unresolved.` });
    }

    const client = await Client.findById(clientId);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    if (item.itemType === 'folder') {
      client.shareFilePath = item.name;
      await client.save();
    } else {
      try {
        const content = await downloadFileContentById(item.itemId);
        const dropboxPath = await uploadFileToDropbox(client.dropboxPath || client.name, item.name, content);

        await FileLog.create({
          source: 'sharefile',
          sourceFileId: item.itemId,
          clientId: client._id,
          originalName: item.name,
          destinationPath: dropboxPath,
          destination: 'dropbox',
          status: 'moved',
          processedAt: new Date(),
        });
      } catch (error) {
        console.error(`resolveUnmatchedItem: could not save file "${item.name}" - ${formatError(error)}`);
        return res.status(502).json({ error: `Could not save this file to Dropbox: ${formatError(error)}` });
      }
    }

    item.status = 'resolved';
    item.resolvedClientId = client._id;
    item.resolvedAt = new Date();
    await item.save();

    const updated = await UnmatchedShareFileItem.findById(item._id).populate('resolvedClientId');
    res.status(200).json(updated);
  } catch (error) {
    next(error);
  }
};

// @desc    Dismiss an unmatched item (e.g. it's a legitimate non-client
//          folder like "Templates") so it stops being flagged on every
//          future scan, without assigning it to any client.
// @route   PATCH /api/unmatched-sharefile-items/:id/dismiss
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
