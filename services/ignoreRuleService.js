const IgnoreRule = require('../models/IgnoreRule');
const EmailLog = require('../models/EmailLog');
const ReviewQueue = require('../models/ReviewQueue');
const UnmatchedShareFileItem = require('../models/UnmatchedShareFileItem');
const UnmatchedDropboxItem = require('../models/UnmatchedDropboxItem');

const CACHE_TTL_MS = 30 * 1000;
const cache = { rules: [], loadedAt: 0 };

const normalizeEmail = (value) => String(value || '').trim().toLowerCase();

const normalizePath = (value) =>
  String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');

const folderOfPath = (value) => {
  const normalized = normalizePath(value);
  const slash = normalized.lastIndexOf('/');
  return slash === -1 ? normalized : normalized.slice(0, slash);
};

const invalidateCache = () => {
  cache.loadedAt = 0;
};

const loadActiveRules = async () => {
  if (Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.rules;
  cache.rules = await IgnoreRule.find({ active: true }).lean();
  cache.loadedAt = Date.now();
  return cache.rules;
};

const pathMatchesRule = (candidatePath, ruleValue) => {
  const path = normalizePath(candidatePath).toLowerCase();
  const rule = normalizePath(ruleValue).toLowerCase();
  if (!rule) return false;
  return path === rule || path.startsWith(`${rule}/`);
};

const isSenderIgnored = async (senderEmail) => {
  const sender = normalizeEmail(senderEmail);
  if (!sender) return false;
  const domain = sender.split('@')[1] || '';
  const rules = await loadActiveRules();
  return rules.some((rule) => {
    if (rule.scope !== 'email' || rule.action !== 'ignore') return false;
    if (rule.type === 'sender_email') return normalizeEmail(rule.value) === sender;
    if (rule.type === 'sender_domain') return normalizeEmail(rule.value) === domain;
    return false;
  });
};

const isShareFilePathIgnored = async (fullPath) => {
  const rules = await loadActiveRules();
  return rules.some(
    (rule) =>
      rule.scope === 'sharefile' &&
      rule.action === 'ignore' &&
      rule.type === 'folder_path' &&
      pathMatchesRule(fullPath, rule.value)
  );
};

const isDropboxPathIgnored = async (fullPath) => {
  const rules = await loadActiveRules();
  return rules.some(
    (rule) =>
      rule.scope === 'dropbox' &&
      rule.action === 'ignore' &&
      rule.type === 'folder_path' &&
      pathMatchesRule(fullPath, rule.value)
  );
};

const folderAssignRuleClientId = async (scope, fullPath) => {
  const rules = await loadActiveRules();
  const match = rules.find(
    (rule) =>
      rule.scope === scope &&
      rule.action === 'assign' &&
      rule.type === 'folder_path' &&
      rule.clientId &&
      pathMatchesRule(fullPath, rule.value)
  );
  return match ? String(match.clientId) : null;
};

const shareFileFolderAssignClientId = (fullPath) => folderAssignRuleClientId('sharefile', fullPath);
const dropboxFolderAssignClientId = (fullPath) => folderAssignRuleClientId('dropbox', fullPath);

const sweepEmail = async (rule) => {
  const value = normalizeEmail(rule.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const senderQuery =
    rule.type === 'sender_domain'
      ? { sender: new RegExp(`@${value}$`, 'i') }
      : { sender: new RegExp(`^${value}$`, 'i') };
  const emailLogs = await EmailLog.find(senderQuery).select('_id').lean();
  if (emailLogs.length === 0) return 0;
  const ids = emailLogs.map((log) => log._id);
  const result = await ReviewQueue.updateMany(
    { type: 'email', referenceId: { $in: ids }, resolvedClientId: null, archivedReason: null },
    { archivedReason: 'manually_dismissed' }
  );
  return result.modifiedCount || 0;
};

const sweepFolderDismiss = async (Model, rule) => {
  const value = normalizePath(rule.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await Model.updateMany(
    { status: 'unresolved', path: new RegExp(`^${value}(/|$)`, 'i') },
    { status: 'dismissed' }
  );
  return result.modifiedCount || 0;
};

const sweepFolderAssign = async (Model, rule) => {
  const value = normalizePath(rule.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const result = await Model.updateMany(
    { status: 'unresolved', path: new RegExp(`^${value}(/|$)`, 'i') },
    { status: 'resolved', resolvedClientId: rule.clientId, resolvedAt: new Date() }
  );
  return result.modifiedCount || 0;
};

const createIgnoreRule = async ({ scope, type, value, action = 'ignore', clientId, label, createdBy }) => {
  const normalizedValue = type === 'folder_path' ? normalizePath(value) : normalizeEmail(value);
  if (!scope || !type || !normalizedValue) {
    const error = new Error('scope, type and value are required');
    error.status = 400;
    throw error;
  }
  if (action === 'assign' && !clientId) {
    const error = new Error('clientId is required for an assign rule');
    error.status = 400;
    throw error;
  }

  const rule = await IgnoreRule.findOneAndUpdate(
    { scope, type, value: normalizedValue, action },
    {
      $set: {
        active: true,
        clientId: action === 'assign' ? clientId : undefined,
        label: label || undefined,
        createdBy: createdBy || undefined,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  invalidateCache();

  let affected = 0;
  if (action === 'assign') {
    if (scope === 'sharefile') affected = await sweepFolderAssign(UnmatchedShareFileItem, rule);
    else if (scope === 'dropbox') affected = await sweepFolderAssign(UnmatchedDropboxItem, rule);
  } else if (scope === 'email') {
    affected = await sweepEmail(rule);
  } else if (scope === 'sharefile') {
    affected = await sweepFolderDismiss(UnmatchedShareFileItem, rule);
  } else if (scope === 'dropbox') {
    affected = await sweepFolderDismiss(UnmatchedDropboxItem, rule);
  }

  return { rule, affected, dismissed: affected };
};

const listIgnoreRules = () =>
  IgnoreRule.find().populate('clientId', 'name').sort({ createdAt: -1 }).lean();

const deleteIgnoreRule = async (id) => {
  const deleted = await IgnoreRule.findByIdAndDelete(id);
  invalidateCache();
  return deleted;
};

module.exports = {
  normalizePath,
  folderOfPath,
  invalidateCache,
  isSenderIgnored,
  isShareFilePathIgnored,
  isDropboxPathIgnored,
  shareFileFolderAssignClientId,
  dropboxFolderAssignClientId,
  createIgnoreRule,
  listIgnoreRules,
  deleteIgnoreRule,
};
