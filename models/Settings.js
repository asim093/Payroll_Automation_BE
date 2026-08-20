const mongoose = require('mongoose');

// Root/starting-point path for each destination — admin-editable via the
// Settings page's "Folder Structure" section. This is where every client's
// folder lives UNDER (e.g. dropboxRootPath "WOTC" + a client's own
// dropboxPath "Acme Corp/Payroll Files" -> "WOTC/Acme Corp/Payroll Files",
// joined by utils/folderPath.js's joinFolderPath()).
//
// Unlike the old *PathTemplate fields these replace, there is no
// "{Client Name}" placeholder here - the client's own dropboxPath/
// shareFilePath (see models/Client.js) is now the FULL remaining path,
// typed entirely by whoever adds the client, not a single segment swapped
// into a fixed template. The root path itself stays freely editable here
// exactly like before.
const settingsSchema = new mongoose.Schema(
  {
    dropboxRootPath: {
      type: String,
      trim: true,
      default: 'WOTC',
    },
    shareFileRootPath: {
      type: String,
      trim: true,
      default: 'Clients',
    },
    outlookRootPath: {
      type: String,
      trim: true,
      default: 'Clients',
    },
    // PHASE-UI-8 (+ UI-9) — how often (in minutes) each of the two
    // independent cron jobs actually does real work (see backend/services/
    // scanThrottle.js). The underlying Render Cron Jobs fire every 5
    // minutes (see render.yaml) so this takes effect on the next tick, no
    // redeploy needed — but 5 is the FLOOR: a value below 5 still only
    // gets checked every 5 minutes. (Originally allowed down to 1, with
    // the cron itself firing every minute to match - reverted after that
    // frequency caused unreliable env-var injection into Render's cron
    // containers on the scheduled path, plus ~10x more container starts/
    // day than this app has ever needed.)
    mailSyncIntervalMinutes: {
      type: Number,
      default: 5,
      min: 5,
      max: 180,
    },
    shareFileBridgeIntervalMinutes: {
      type: Number,
      default: 5,
      min: 5,
      max: 180,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Settings', settingsSchema);
