require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const UnmatchedShareFileItem = require('./models/UnmatchedShareFileItem');
const { getShareFileContext } = require('./services/sharefileService');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pickDate = (item, isFolder) => {
  const raw = isFolder
    ? item.CreationDate || item.ClientCreatedDate
    : item.CreationDate || item.ClientCreatedDate || item.ProgenyEditDate || item.ClientModifiedDate;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

(async () => {
  let failed = false;
  try {
    await connectDB();

    const items = await UnmatchedShareFileItem.find({
      status: { $in: ['unresolved', 'dismissed'] },
      $or: [{ sourceCreatedAt: { $exists: false } }, { sourceCreatedAt: null }],
    }).lean();

    console.log(`[BACKFILL] ${items.length} items need a sourceCreatedAt.`);

    let ctx = await getShareFileContext();
    let updated = 0;
    let missing = 0;

    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      const url = `${ctx.apiBase}/Items(${item.itemId})?$select=Id,Name,CreationDate,ClientCreatedDate,ProgenyEditDate,ClientModifiedDate`;
      let res = await fetch(url, { headers: ctx.authHeaders });
      if (res.status === 401) {
        ctx = await getShareFileContext({ forceRefresh: true });
        res = await fetch(url, { headers: ctx.authHeaders });
      }
      if (!res.ok) {
        missing += 1;
        console.warn(`  ${item.path}: lookup failed (${res.status})`);
        await sleep(50);
        continue;
      }
      const meta = await res.json();
      const date = pickDate(meta, item.itemType === 'folder');
      if (!date) {
        missing += 1;
        await sleep(30);
        continue;
      }
      await UnmatchedShareFileItem.updateOne({ _id: item._id }, { sourceCreatedAt: date });
      updated += 1;
      if (updated % 25 === 0) console.log(`  ...${updated}/${items.length}`);
      await sleep(30);
    }

    console.log(`[BACKFILL] Done. updated: ${updated}, no date found: ${missing}`);
  } catch (error) {
    failed = true;
    console.error('[BACKFILL] Failed:', error.message);
  } finally {
    await mongoose.connection.close();
  }
  process.exit(failed ? 1 : 0);
})();
