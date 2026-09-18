const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

const isPaginationRequested = (query) => query.page !== undefined || query.limit !== undefined;


const paginate = async (query, countFilterModel, filter, reqQuery = {}, options = {}) => {
  const { sortFields = {}, defaultSort = {} } = options;

  const sortBy = reqQuery.sortBy && sortFields[reqQuery.sortBy] ? sortFields[reqQuery.sortBy] : null;
  const sortDir = reqQuery.sortDir === 'desc' ? -1 : 1;
  const sort = sortBy ? { [sortBy]: sortDir } : defaultSort;

  if (!isPaginationRequested(reqQuery)) {
    return query.sort(sort);
  }

  const page = Math.max(1, parseInt(reqQuery.page, 10) || 1);
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(reqQuery.limit, 10) || DEFAULT_LIMIT));
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    query.sort(sort).skip(skip).limit(limit),
    countFilterModel.countDocuments(filter),
  ]);

  return { items, total, page, limit };
};

module.exports = { paginate, isPaginationRequested, DEFAULT_LIMIT, MAX_LIMIT };
