const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema(
  {
    dropboxPathTemplate: {
      type: String,
      trim: true,
      default: 'WOTC/{Client Name}',
    },
    shareFilePathTemplate: {
      type: String,
      trim: true,
      default: 'Clients/{Client Name}',
    },
    
    outlookPathTemplate: {
      type: String,
      trim: true,
      default: 'Clients/{Client Name}',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
