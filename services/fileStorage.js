const fs = require('fs');
const path = require('path');
const { generateUniqueFilename } = require('../utils/generateUniqueFilename');

const STORAGE_ROOT = path.join(__dirname, '..', 'storage');

const sanitizeForPath = (value) => String(value).replace(/[\\/:*?"<>|]/g, '_').trim();

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
