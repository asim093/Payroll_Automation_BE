// Integration + regression suite for the shared-folder-path guard (Tier 1 fix
// for BUG-13 / P7).
//
//   node testFolderCollisionGuard.js
//
// Requires the API server running on localhost:5000 and Dropbox configured.
// Creates/deletes test clients under the "ZZ-TESTGUARD-" prefix and a Dropbox
// folder tree under "ZZ-TESTGUARD/". ShareFile assertions are best-effort (the
// shared rotating token often 401s for a second process); the guard's decision
// logic is DB-only and is asserted regardless.

require('dotenv').config();
const mongoose = require('mongoose');
const crypto = require('crypto');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const dbx = require('./services/dropboxService');
const { deleteClientFolders } = require('./services/clientFolderCleanupService');
const { dropboxFolderKey, shareFileFolderKey, loadFolderIdentitySettings } = require('./utils/clientFolderIdentity');

const API = 'http://127.0.0.1:5000';
const PREFIX = 'ZZ-TESTGUARD-';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const ok = (label, cond, extra) => {
  if (cond) { passed += 1; console.log(`  ok   ${label}`); }
  else { failed += 1; console.log(`  FAIL ${label}${extra ? ` — ${extra}` : ''}`); }
};

const api = async (method, path, body) => {
  for (let i = 0; i < 5; i += 1) {
    try {
      const r = await fetch(API + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await r.json(); } catch { /* no body */ }
      return { status: r.status, json };
    } catch {
      await sleep(3000);
    }
  }
  throw new Error(`API unreachable: ${method} ${path}`);
};

const dropboxSeg = (name) => `ZZ-TESTGUARD/${name}/Payroll Files`;
const shareFileSeg = (name) => `ZZ-TESTGUARD ${name.replace(PREFIX, '')}`;

const mongooseClient = (name, overrides = {}) =>
  Client.create({
    name,
    status: 'active',
    matchingRules: {},
    dropboxPath: dropboxSeg(name),
    dropboxPathIsAbsolute: false,
    shareFilePath: shareFileSeg(name),
    shareFilePathIsAbsolute: false,
    ...overrides,
  });

const putMarker = async (name) => {
  await dbx.uploadFileToDropbox(dropboxSeg(name), `${name}-MARKER.txt`, Buffer.from(`${name} data ${Date.now()}`), undefined, false);
};
const markerSha = async (name) => {
  const files = await dbx.listAllFilesInFolder(dropboxSeg(name), false).catch(() => null);
  if (!Array.isArray(files)) return null;
  const m = files.find((f) => /MARKER/i.test(f.name));
  if (!m) return null;
  const buf = await dbx.downloadDropboxFileBuffer(m.path);
  return crypto.createHash('sha256').update(buf).digest('hex');
};
// deleteClientFolders acts on client.dropboxPath (the ".../Payroll Files" leaf);
// the parent folder is intentionally left behind. Check the leaf, not the parent.
const dropboxFolderGone = async (name) => {
  const r = await dbx.deleteDropboxFolder(dropboxSeg(name), false).catch(() => ({ deleted: false }));
  return r.deleted === false;
};

const captureLogs = async (fn) => {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => { lines.push(args.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
};

const cleanup = async () => {
  const leftovers = await Client.find({ name: new RegExp(`^${PREFIX}`) }).lean();
  for (const c of leftovers) {
    await api('DELETE', `/api/clients/${c._id}?deleteFolders=true`).catch(() => {});
  }
  await Client.deleteMany({ name: new RegExp(`^${PREFIX}`) });
  await dbx.deleteDropboxFolder('ZZ-TESTGUARD', false).catch(() => {});
  const { deleteShareFileFolder } = require('./services/sharefileService');
  try {
    const { getShareFileContext } = require('./services/sharefileService');
    const ctx = await getShareFileContext();
    const bp = await fetch(`${ctx.apiBase}/Items(${ctx.rootId})/ByPath?path=${encodeURIComponent('Clients')}`, { headers: ctx.authHeaders });
    const cf = await bp.json();
    if (cf.Id) {
      const ch = await fetch(`${ctx.apiBase}/Items(${cf.Id})/Children?$select=Name`, { headers: ctx.authHeaders });
      const d = await ch.json();
      for (const f of (d.value || [])) {
        if (/ZZ-TESTGUARD/i.test(f.Name || '')) await deleteShareFileFolder(`Clients/${f.Name}`).catch(() => {});
      }
    }
  } catch { /* best effort */ }
  try {
    const { getAccessTokenFromRefreshToken } = require('./services/delegatedAuthService');
    const tok = await getAccessTokenFromRefreshToken();
    const top = await fetch('https://graph.microsoft.com/v1.0/me/mailFolders?$top=250&$select=id,displayName', { headers: { Authorization: `Bearer ${tok}` } });
    const tj = await top.json();
    const clientsF = (tj.value || []).find((f) => /^clients$/i.test(f.displayName));
    if (clientsF) {
      let url = `https://graph.microsoft.com/v1.0/me/mailFolders/${clientsF.id}/childFolders?$top=250&$select=id,displayName`;
      while (url) {
        const cr = await fetch(url, { headers: { Authorization: `Bearer ${tok}` } });
        const cj = await cr.json();
        for (const f of (cj.value || [])) {
          if (/ZZ-TESTGUARD/i.test(f.displayName)) {
            await fetch(`https://graph.microsoft.com/v1.0/me/mailFolders/${f.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } });
          }
        }
        url = cj['@odata.nextLink'];
      }
    }
  } catch { /* best effort */ }
};

const run = async () => {
  await connectDB();
  const settings = await loadFolderIdentitySettings();
  await cleanup();

  // ============ INTEGRATION: P7 closed on CREATE ============
  console.log('\n[integration] P7 — server blocks an equivalent-but-differently-formatted path on CREATE');
  const owner = await mongooseClient(`${PREFIX}OWNER`); // stored relative
  {
    // equivalent absolute form of OWNER's dropbox path
    const equivAbsolute = `/${dropboxSeg(`${PREFIX}OWNER`)}`;
    const res = await api('POST', '/api/clients', {
      name: `${PREFIX}CLONE`,
      matchingRules: {},
      dropboxPath: equivAbsolute,
      dropboxPathIsAbsolute: true,
      shareFilePath: `ZZ-TESTGUARD CLONE-unique`,
      shareFilePathIsAbsolute: false,
    });
    ok('POST equivalent path -> 409 shared_folder_path', res.status === 409 && res.json?.error === 'shared_folder_path', `got ${res.status} ${res.json?.error}`);
    ok('409 body lists the colliding client', (res.json?.collisions || []).some((c) => c.clientName === `${PREFIX}OWNER` && c.type === 'Dropbox'));
    ok('no CLONE client was created', (await Client.countDocuments({ name: `${PREFIX}CLONE` })) === 0);
  }

  // ============ INTEGRATION: allowSharedPath override lets it through ============
  console.log('\n[integration] override — allowSharedPath:true bypasses the 409');
  {
    const res = await api('POST', '/api/clients', {
      name: `${PREFIX}CLONE`,
      matchingRules: {},
      dropboxPath: `/${dropboxSeg(`${PREFIX}OWNER`)}`,
      dropboxPathIsAbsolute: true,
      shareFilePath: `ZZ-TESTGUARD CLONE-unique`,
      shareFilePathIsAbsolute: false,
      allowSharedPath: true,
    });
    ok('POST with allowSharedPath:true -> not 409', res.status !== 409, `got ${res.status}`);
    const clone = await Client.findOne({ name: `${PREFIX}CLONE` }).lean();
    ok('CLONE client was created', Boolean(clone));
    ok('allowSharedPath not persisted as a field', clone && clone.allowSharedPath === undefined);
    ok('CLONE now shares OWNER\'s canonical dropbox key', clone && dropboxFolderKey(clone, settings.dropboxRootPath) === dropboxFolderKey(owner, settings.dropboxRootPath));
  }

  // ============ INTEGRATION: P7 closed on UPDATE ============
  console.log('\n[integration] P7 — server blocks an equivalent path on UPDATE');
  const mover = await mongooseClient(`${PREFIX}MOVER`);
  {
    const res = await api('PUT', `/api/clients/${mover._id}`, {
      dropboxPath: `/${dropboxSeg(`${PREFIX}OWNER`)}`,
      dropboxPathIsAbsolute: true,
    });
    ok('PUT equivalent path onto OWNER -> 409', res.status === 409 && res.json?.error === 'shared_folder_path', `got ${res.status} ${res.json?.error}`);
    const after = await Client.findById(mover._id).lean();
    ok('MOVER path unchanged after 409', after.dropboxPath === dropboxSeg(`${PREFIX}MOVER`) && !after.dropboxPathIsAbsolute);
  }
  {
    const res = await api('PUT', `/api/clients/${mover._id}`, {
      matchingRules: { emailAddresses: [], domains: ['zz-testguard.example'] },
    });
    ok('PUT matchingRules-only (no path keys) -> 200, guard skipped', res.status === 200);
  }

  // ============ INTEGRATION: BUG-13 both directions ============
  console.log('\n[integration] BUG-13 — deleting a merged client never deletes the other client\'s folder');
  await cleanup();
  for (const [victimSuffix, deleteSuffix, label] of [
    ['A1', 'B1', 'delete the folder OWNER (A1), B1 merged onto it'],
    ['A2', 'B2', 'delete the merged LOSER (B2) — the exact D21 case'],
  ]) {
    const isD21 = label.includes('D21');
    const a = await mongooseClient(`${PREFIX}${victimSuffix}`);
    const b = await mongooseClient(`${PREFIX}${deleteSuffix}`);
    await dbx.uploadFileToDropbox(dropboxSeg(a.name), `${a.name}-MARKER.txt`, Buffer.from(`keep me ${Date.now()}`), undefined, false);
    await dbx.uploadFileToDropbox(dropboxSeg(b.name), `${b.name}-MARKER.txt`, Buffer.from(`b marker ${Date.now()}`), undefined, false);
    const aShaBefore = await markerSha(a.name);
    // merge b onto a (direct DB write, mirrors a confirmed collision)
    await Client.updateOne({ _id: b._id }, { $set: { dropboxPath: a.dropboxPath, dropboxPathIsAbsolute: a.dropboxPathIsAbsolute, shareFilePath: a.shareFilePath, shareFilePathIsAbsolute: a.shareFilePathIsAbsolute } });

    const toDelete = isD21 ? b : a;
    const toKeep = isD21 ? a : b;
    const res = await api('DELETE', `/api/clients/${toDelete._id}?deleteFolders=true`);
    console.log(`   (${label})`);
    ok('delete responds 200', res.status === 200);
    ok('deleted client record is gone', (await Client.findById(toDelete._id)) === null);
    ok('other client record intact', (await Client.findById(toKeep._id)) !== null);
    ok('Dropbox folderWarnings say "kept because ... also used by"', (res.json?.folderWarnings || []).some((w) => /Dropbox folder was kept because it is also used by/.test(w)));
    ok('ShareFile folderWarnings say "kept because ... also used by"', (res.json?.folderWarnings || []).some((w) => /ShareFile folder was kept because it is also used by/.test(w)));
    ok('the shared Dropbox folder + marker survived unchanged', (await markerSha(a.name)) === aShaBefore && aShaBefore !== null);

    // cleanup this pair: revert b's path, then delete both with folders + orphan
    await Client.updateOne({ _id: toKeep._id }, { $set: { dropboxPath: dropboxSeg(toKeep.name), dropboxPathIsAbsolute: false, shareFilePath: shareFileSeg(toKeep.name), shareFilePathIsAbsolute: false } }).catch(() => {});
    await api('DELETE', `/api/clients/${toKeep._id}?deleteFolders=true`).catch(() => {});
    await dbx.deleteDropboxFolder(`ZZ-TESTGUARD/${a.name}`, false).catch(() => {});
    await dbx.deleteDropboxFolder(`ZZ-TESTGUARD/${b.name}`, false).catch(() => {});
  }

  // ============ INTEGRATION: log line names folder + client separately ============
  console.log('\n[integration] log — [CLIENT CLEANUP] skip line carries the resolved folder path');
  await cleanup();
  {
    const keep = await mongooseClient(`${PREFIX}LOGKEEP`);
    const drop = await mongooseClient(`${PREFIX}LOGDROP`);
    await Client.updateOne({ _id: drop._id }, { $set: { dropboxPath: keep.dropboxPath, shareFilePath: keep.shareFilePath } });
    const dropDoc = await Client.findById(drop._id);
    const logs = await captureLogs(() => deleteClientFolders(dropDoc));
    const dropboxSkip = logs.find((l) => /\[CLIENT CLEANUP\] Dropbox folder .* NOT deleted/.test(l));
    const expectedResolved = require('./utils/folderPath').resolveDropboxFolderPathSync(
      settings.dropboxRootPath, keep.dropboxPath, Boolean(keep.dropboxPathIsAbsolute)
    );
    ok('a Dropbox skip line was logged', Boolean(dropboxSkip), JSON.stringify(logs));
    ok('skip line contains the resolved folder path', dropboxSkip && dropboxSkip.includes(expectedResolved), `expected "${expectedResolved}" in: ${dropboxSkip}`);
    ok('skip line names the requesting client separately', dropboxSkip && dropboxSkip.includes(`requested for client "${PREFIX}LOGDROP"`), dropboxSkip);
    ok('skip line names the sharer', dropboxSkip && dropboxSkip.includes(`"${PREFIX}LOGKEEP"`), dropboxSkip);
    await Client.deleteOne({ _id: drop._id });
    await api('DELETE', `/api/clients/${keep._id}?deleteFolders=true`).catch(() => {});
    await dbx.deleteDropboxFolder(`ZZ-TESTGUARD/${PREFIX}LOGKEEP`, false).catch(() => {});
  }

  // ============ REGRESSION: normal operations unaffected ============
  console.log('\n[regression] normal create / rename-to-free-path / delete of a non-shared client');
  await cleanup();
  {
    const res = await api('POST', '/api/clients', {
      name: `${PREFIX}NORMAL`,
      matchingRules: {},
      dropboxPath: dropboxSeg(`${PREFIX}NORMAL`),
      dropboxPathIsAbsolute: false,
      shareFilePath: shareFileSeg(`${PREFIX}NORMAL`),
      shareFilePathIsAbsolute: false,
    });
    ok('normal create -> 201', res.status === 201, `got ${res.status} ${JSON.stringify(res.json).slice(0, 120)}`);
    const created = res.json;
    ok('created client persisted', Boolean(created?._id));
    await sleep(1500);
    ok('Dropbox folder was created', (await dbx.listAllFilesInFolder(dropboxSeg(`${PREFIX}NORMAL`), false).then(() => true).catch(() => false)));
    await putMarker(`${PREFIX}NORMAL`);
    const shaBefore = await markerSha(`${PREFIX}NORMAL`);

    // rename to a free path
    const renameRes = await api('PUT', `/api/clients/${created._id}`, {
      name: `${PREFIX}NORMAL2`,
      dropboxPath: dropboxSeg(`${PREFIX}NORMAL2`),
      dropboxPathIsAbsolute: false,
      shareFilePath: shareFileSeg(`${PREFIX}NORMAL2`),
      shareFilePathIsAbsolute: false,
    });
    ok('rename to a free path -> 200 (no false 409)', renameRes.status === 200, `got ${renameRes.status} ${renameRes.json?.error}`);
    await sleep(1500);
    ok('Dropbox folder moved, marker rode along unchanged', (await markerSha(`${PREFIX}NORMAL2`)) === shaBefore && shaBefore !== null);
    ok('old Dropbox path is gone', await dropboxFolderGone(`${PREFIX}NORMAL`));

    // delete a non-shared client -> folder actually deleted, no "kept" warning
    const delRes = await api('DELETE', `/api/clients/${created._id}?deleteFolders=true`);
    ok('delete non-shared client -> 200', delRes.status === 200);
    ok('no "kept because ... also used by" warning', !(delRes.json?.folderWarnings || []).some((w) => /kept because it is also used by/.test(w)));
    await sleep(1500);
    ok('Dropbox folder was actually deleted', await dropboxFolderGone(`${PREFIX}NORMAL2`));
  }

  await cleanup();
  console.log(`\n${passed} passed, ${failed} failed`);
  await mongoose.disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

run().catch(async (error) => {
  console.error('testFolderCollisionGuard ERROR:', error);
  try { await cleanup(); } catch { /* ignore */ }
  process.exit(2);
});
