const { processShareFileScan } = require('../processShareFileScan');
const { runGuardedProcess } = require('./processRunner');

const PROCESS_KEY = 'shareFileBridge';

const runShareFileBridgeOnce = async () => {
  console.log(`\n[SHAREFILE-BRIDGE] Run started at ${new Date().toISOString()}`);

  return runGuardedProcess(PROCESS_KEY, async () => {
    try {
      console.log('[SHAREFILE-BRIDGE] Running ShareFile scan...');
      const summary = await processShareFileScan();
      console.log(`[SHAREFILE-BRIDGE] Run ended at ${new Date().toISOString()}`);
      return { success: true, summary };
    } catch (error) {
      console.error('[SHAREFILE-BRIDGE] ERROR:', error.message);
      return { success: false, error: error.message };
    }
  });
};

module.exports = { runShareFileBridgeOnce };
