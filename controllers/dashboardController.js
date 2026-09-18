const Client = require('../models/Client');
const FileLog = require('../models/FileLog');
const ReviewQueue = require('../models/ReviewQueue');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');

const DEAD_CLIENT_DAYS = 30;
const DAY_LABELS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
const DAY_MS = 24 * 60 * 60 * 1000;

// All the numbers DashboardPage.jsx needs, computed with counts/aggregation
// against FileLog/ReviewQueue/UnmatchedShareFileItem/Client — never the full
// collections. This is the dedicated stats endpoint: unlike the paginated
// list endpoints (matching-rules, clients/with-last-activity), a dashboard
// summary can't be "paginated" — it has to see everything to produce a
// correct total/percentage — so the limit here is on what's SHAPED and sent
// back (a handful of numbers), not on how many source documents get scanned.
exports.getDashboardStats = async (req, res, next) => {
  try {
    const now = new Date();
    const nowMs = now.getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const weekStart = (() => {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      const day = d.getDay();
      d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
      return d;
    })();

    const dayStarts = [];
    for (let i = 6; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      dayStarts.push(d);
    }
    const bucketBoundaries = [...dayStarts, new Date(dayStarts[dayStarts.length - 1].getTime() + DAY_MS)];

    const [facetResult, activeClients, needsReviewCount, needsReviewShareFileCount] = await Promise.all([
      FileLog.aggregate([
        { $match: { status: 'moved' } },
        { $addFields: { ts: { $ifNull: ['$processedAt', { $ifNull: ['$updatedAt', '$createdAt'] }] } } },
        {
          $facet: {
            thisMonth: [{ $match: { ts: { $gte: monthStart } } }, { $count: 'n' }],
            lastMonth: [{ $match: { ts: { $gte: lastMonthStart, $lt: monthStart } } }, { $count: 'n' }],
            thisWeek: [{ $match: { ts: { $gte: weekStart } } }, { $count: 'n' }],
            daily: [
              { $match: { ts: { $gte: bucketBoundaries[0], $lt: bucketBoundaries[bucketBoundaries.length - 1] } } },
              {
                $bucket: {
                  groupBy: '$ts',
                  boundaries: bucketBoundaries,
                  default: 'other',
                  output: { count: { $sum: 1 } },
                },
              },
            ],
            lastFileByClient: [
              { $match: { clientId: { $ne: null } } },
              { $group: { _id: '$clientId', lastAt: { $max: '$ts' } } },
            ],
          },
        },
      ]),
      Client.find({ status: 'active' }).select('_id createdAt').lean(),
      ReviewQueue.countDocuments({ resolvedClientId: null, archivedReason: null }),
      UnmatchedShareFileItem.countDocuments({ status: 'unresolved' }),
    ]);

    const facet = facetResult[0] || {};
    const filesThisMonth = facet.thisMonth?.[0]?.n || 0;
    const filesLastMonth = facet.lastMonth?.[0]?.n || 0;
    const filesThisWeek = facet.thisWeek?.[0]?.n || 0;
    const monthDeltaPercent =
      filesLastMonth === 0 ? null : Math.round(((filesThisMonth - filesLastMonth) / filesLastMonth) * 100);

    const dailyCountByBucketStart = new Map(
      (facet.daily || [])
        .filter((bucket) => bucket._id !== 'other')
        .map((bucket) => [new Date(bucket._id).getTime(), bucket.count])
    );
    const maxDaily = Math.max(1, ...dayStarts.map((d) => dailyCountByBucketStart.get(d.getTime()) || 0));
    const dailyBars = dayStarts.map((d) => {
      const count = dailyCountByBucketStart.get(d.getTime()) || 0;
      return {
        key: d.getTime(),
        label: DAY_LABELS[d.getDay()],
        count,
        heightPercent: count === 0 ? 6 : Math.max(10, (count / maxDaily) * 100),
      };
    });

    const lastFileByClientId = new Map(
      (facet.lastFileByClient || []).map((row) => [String(row._id), new Date(row.lastAt).getTime()])
    );
    const thresholdMs = DEAD_CLIENT_DAYS * DAY_MS;
    const deadClientsCount = activeClients.filter((client) => {
      const createdAt = new Date(client.createdAt).getTime();
      if (Number.isNaN(createdAt) || nowMs - createdAt < thresholdMs) return false;
      const lastFile = lastFileByClientId.get(String(client._id));
      return !lastFile || nowMs - lastFile > thresholdMs;
    }).length;

    res.status(200).json({
      filesThisMonth,
      filesThisWeek,
      monthDeltaPercent,
      dailyBars,
      deadClientsCount,
      needsReviewCount: needsReviewCount + needsReviewShareFileCount,
    });
  } catch (error) {
    next(error);
  }
};
