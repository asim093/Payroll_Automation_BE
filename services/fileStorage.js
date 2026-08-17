const fs = require('fs');
const path = require('path');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');

const STORAGE_ROOT = path.join(__dirname, '..', 'storage');

// Client names can contain characters that aren't safe in folder/file names
// (e.g. "/", ":"); replace them so we never write outside STORAGE_ROOT.
const sanitizeForPath = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_').trim();

/**
 * Save a base64-encoded email attachment into
 * backend/storage/{clientName}/{timestamp}_{attachment.name}, creating the
 * client's folder if it doesn't exist yet. The timestamp prefix (see
 * generateUniqueFilename) stops two attachments with the same original name
 * from overwriting each other. Returns the full path of the saved file.
 *
 * @param {string} clientName
 * @param {{name: string, contentBase64: string}} attachment
 * @param {Date} [referenceDate] - pass the same Date used for other
 *   destinations (e.g. Dropbox) of this same attachment, so both end up
 *   with an identical unique filename.
 */
const saveAttachmentToClientFolder = (clientName, attachment, referenceDate) => {
  try {
    const clientFolder = path.join(STORAGE_ROOT, sanitizeForPath(clientName));
    fs.mkdirSync(clientFolder, { recursive: true });

    const uniqueName = generateUniqueFilename(attachment.name, referenceDate);
    const fileName = sanitizeForPath(uniqueName);
    const filePath = path.join(clientFolder, fileName);

    const fileBuffer = Buffer.from(attachment.contentBase64, 'base64');
    fs.writeFileSync(filePath, fileBuffer);

    return filePath;
  } catch (error) {
    console.error(
      `saveAttachmentToClientFolder ERROR: could not save "${attachment?.name}" for client "${clientName}" — ${error.message}`
    );
    throw error;
  }
};

module.exports = { saveAttachmentToClientFolder, STORAGE_ROOT };
