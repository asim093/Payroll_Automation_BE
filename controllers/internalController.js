const { broadcastScanActivity } = require('../services/socketService');
const { deriveScanActivityView } = require('../utils/scanActivityView');

const notifyProgress = (req, res) => {
  const providedSecret = req.headers['x-internal-secret'];

  if (!process.env.INTERNAL_NOTIFY_SECRET) {
    return res.status(500).json({ error: 'INTERNAL_NOTIFY_SECRET is not configured on this server' });
  }
  if (!providedSecret || providedSecret !== process.env.INTERNAL_NOTIFY_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { processKey, ...rawState } = req.body || {};
  if (!processKey) {
    return res.status(400).json({ error: 'processKey is required' });
  }

  const view = deriveScanActivityView(rawState);
  broadcastScanActivity({ processKey, ...view });

  res.status(200).json({ received: true });
};

module.exports = { notifyProgress };
