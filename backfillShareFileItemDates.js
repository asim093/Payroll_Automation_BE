const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const UnmatchedShareFileItem = require('./models/UnmatchedShareFileItem');
const { getShareFileContext } = require('./services/sharefileService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pickDate = (item) => {
  const raw = item.CreationDate || item.ClientCreatedDate || item.ProgenyEditDate || item.ClientModifiedDate;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

(async () => {
  let failed = false;
  try {
    await connectDB();

    const items = await UnmatchedShareFileItem.find({ status: { $in: ['unresolved', 'dismissed'] } }).lean();
    console.log(`[BACKFILL] Checking ${items.length} ShareFile items.`);

    let ctx = null;
    let alignedLocally = 0;
    let fetched = 0;
    let noDate = 0;

    for (const item of items) {
      let source = item.sourceCreatedAt ? new Date(item.sourceCreatedAt) : null;

      if (!source) {
        if (!ctx) ctx = await getShareFileContext();
        const url = `${ctx.apiBase}/Items(${item.itemId})?$select=Id,Name,CreationDate,ClientCreatedDate,ProgenyEditDate,ClientModifiedDate`;
        let res = await fetch(url, { headers: ctx.authHeaders });
        if (res.status === 401) {
          ctx = await getShareFileContext({ forceRefresh: true });
          res = await fetch(url, { headers: ctx.authHeaders });
        }
        if (!res.ok) {
          noDate += 1;
          console.warn(`  ${item.path}: lookup failed (${res.status})`);
          await sleep(40);
          continue;
        }
        source = pickDate(await res.json());
        fetched += 1;
        await sleep(30);
        if (!source) {
          noDate += 1;
          continue;
        }
      }

      const update = {};
      if (!item.sourceCreatedAt) update.sourceCreatedAt = source;
      if (!item.discoveredAt || new Date(item.discoveredAt) > source) update.discoveredAt = source;

      if (Object.keys(update).length > 0) {
        await UnmatchedShareFileItem.updateOne({ _id: item._id }, update);
        alignedLocally += 1;
        if (alignedLocally % 50 === 0) console.log(`  ...${alignedLocally} aligned`);
      }
    }

    console.log(
      `[BACKFILL] Done. discoveredAt aligned to source date: ${alignedLocally} | looked up from ShareFile: ${fetched} | no date found: ${noDate}`
    );
  } catch (error) {
    failed = true;
    console.error('[BACKFILL] Failed:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
})();
