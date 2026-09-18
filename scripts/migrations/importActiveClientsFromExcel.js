const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const { Dropbox } = require('dropbox');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');
const { getDropboxAccessToken } = require('../../services/dropboxService');
const { resolveDropboxFolderPathSync } = require('../../utils/folderPath');
const { getShareFileContext } = require('../../services/sharefileService');
const { formatError } = require('../../utils/formatError');


const CSV_PATH = path.join(__dirname, '..', '..', 'clients_export_active.csv');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'data', 'importResults.csv');

const getDropboxPathRoot = () => {
  const namespaceId = process.env.DROPBOX_TEAM_FOLDER_NAMESPACE_ID;
  if (!namespaceId) return undefined;
  return JSON.stringify({ '.tag': 'namespace_id', namespace_id: namespaceId });
};

const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else field += char;
    } else if (char === '"') inQuotes = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\r') { /* ignore */ }
    else if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
};

const csvEscape = (value) => {
  const str = String(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));


const normalizeName = (name) => {
  let normalized = String(name || '').toLowerCase().replace(/[.,'']/g, '').trim();
  normalized = normalized.replace(/\b(inc|llc|ltd|corp|co)\b\.?\s*$/i, '').trim();
  return normalized.replace(/\s+/g, ' ');
};

const isShareFileFileItem = (item) =>
  item['odata.type'] ? item['odata.type'].includes('.File') : typeof item.Id === 'string' && item.Id.startsWith('fi');

const withRetry = async (fn, label, maxAttempts = 3) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxAttempts) {
        console.error(`${label} FAILED after ${maxAttempts} attempts: ${formatError(error)}`);
        throw error;
      }
      await sleep(500 * attempt);
    }
  }
  return undefined;
};

const dropboxListFolder = async (dbx, folderPath) => {
  try {
    return await withRetry(async () => {
      let response = await dbx.filesListFolder({ path: folderPath });
      const entries = [...response.result.entries];
      while (response.result.has_more) {
        response = await dbx.filesListFolderContinue({ cursor: response.result.cursor });
        entries.push(...response.result.entries);
      }
      return entries;
    }, `Dropbox listFolder("${folderPath}")`);
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path/not_found')) return [];
    throw error;
  }
};

const dropboxFolderExists = async (dbx, folderPath) => {
  try {
    await withRetry(() => dbx.filesGetMetadata({ path: folderPath }), `Dropbox getMetadata("${folderPath}")`);
    return true;
  } catch (error) {
    const errorSummary = error?.error?.error_summary || '';
    if (errorSummary.startsWith('path/not_found')) return false;
    throw error;
  }
};

const shareFileFetchChildren = async (apiBase, authHeaders, folderId) => {
  const entries = [];
  let skip = 0;
  const pageSize = 1000;
  while (true) {
    const page = await withRetry(async () => {
      const response = await fetch(`${apiBase}/Items(${folderId})/Children?$top=${pageSize}&$skip=${skip}`, {
        headers: authHeaders,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()).value || [];
    }, `ShareFile Children(${folderId})`);
    entries.push(...page);
    if (page.length < pageSize) break;
    skip += pageSize;
  }
  return entries;
};

const shareFileExactMatch = async (apiBase, authHeaders, rootId, fullPath) => {
  try {
    const item = await withRetry(async () => {
      const response = await fetch(`${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(fullPath)}`, {
        headers: authHeaders,
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    }, `ShareFile ByPath("${fullPath}")`);
    return item && item.Id ? true : false;
  } catch (error) {
    console.error(`ShareFile exact-check ERROR ("${fullPath}"): ${formatError(error)}`);
    return false;
  }
};

(async () => {
  try {
    await connectDB();

    if (!fs.existsSync(CSV_PATH)) {
      console.error(`FATAL: source CSV not found at ${CSV_PATH}`);
      process.exit(1);
    }

    const csvText = fs.readFileSync(CSV_PATH, 'utf8');
    const rows = parseCsv(csvText);
    const header = rows[0];
    const limit = process.env.IMPORT_LIMIT ? parseInt(process.env.IMPORT_LIMIT, 10) : undefined;
    const dataRows = limit ? rows.slice(1, 1 + limit) : rows.slice(1);
    const col = (name) => header.indexOf(name);
    const idx = {
      customer: col('Customer'),
      fein: col('FEIN'),
      wotcFormUrl: col('WOTC Form URL'),
      emailSalutation: col('WOTC Email Salutation'),
      complianceReportEmailDistribution: col('WOTC Email Distribution'),
    };
    console.log(`Loaded ${dataRows.length} rows from ${CSV_PATH}`);
    console.log('NOTE: CSV has no "complianceReportFrequency"-equivalent column — that field is left unset for every imported client.\n');

    const existingClients = await Client.find({}, 'name').lean();
    const existingNameSet = new Set(existingClients.map((c) => c.name.toLowerCase().trim()));
    const existingNormalizedMap = new Map(existingClients.map((c) => [normalizeName(c.name), c.name]));

    const accessToken = await getDropboxAccessToken();
    const pathRoot = getDropboxPathRoot();
    const dbx = pathRoot ? new Dropbox({ accessToken, fetch, pathRoot }) : new Dropbox({ accessToken, fetch });
    console.log(`Dropbox client created ${pathRoot ? 'WITH' : 'WITHOUT'} team-namespace pathRoot header.`);

    const dropboxRootEntries = await dropboxListFolder(dbx, '');
    const dropboxRootFolders = dropboxRootEntries.filter((e) => e['.tag'] === 'folder');
    const dropboxNormalizedMap = new Map();
    for (const folder of dropboxRootFolders) {
      const key = normalizeName(folder.name);
      if (!dropboxNormalizedMap.has(key)) dropboxNormalizedMap.set(key, []);
      dropboxNormalizedMap.get(key).push(folder.name);
    }
    console.log(`Fetched ${dropboxRootFolders.length} Dropbox root folders for fallback matching.`);

    const { apiBase, authHeaders, rootId } = await getShareFileContext();
    const shareFileRootPath = 'Clients';
    const clientsRootId = await withRetry(async () => {
      const response = await fetch(`${apiBase}/Items(${rootId})/ByPath?path=${encodeURIComponent(shareFileRootPath)}`, {
        headers: authHeaders,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()).Id;
    }, `ShareFile resolve root "${shareFileRootPath}"`);

    const shareFileChildren = await shareFileFetchChildren(apiBase, authHeaders, clientsRootId);
    const shareFileFolders = shareFileChildren.filter((item) => !isShareFileFileItem(item));
    const shareFileNormalizedMap = new Map();
    for (const folder of shareFileFolders) {
      const name = folder.Name || folder.FileName;
      const key = normalizeName(name);
      if (!shareFileNormalizedMap.has(key)) shareFileNormalizedMap.set(key, []);
      shareFileNormalizedMap.get(key).push(name);
    }
    console.log(`Fetched ${shareFileFolders.length} ShareFile folders under "Clients" for fallback matching.\n`);

    const results = [];
    const errors = [];

    for (const row of dataRows) {
      const customer = (row[idx.customer] || '').trim();
      if (!customer) continue;

      try {
        const normalizedMatch = existingNormalizedMap.get(normalizeName(customer));
        if (existingNameSet.has(customer.toLowerCase())) {
          results.push({ customer, outcome: 'skipped_exists', dropboxPath: '', shareFilePath: '', warnings: 'Client already exists — skipped' });
          console.log(`${customer} | SKIPPED (already exists)`);
          continue;
        }
        if (normalizedMatch) {
          results.push({
            customer,
            outcome: 'skipped_near_duplicate',
            dropboxPath: '',
            shareFilePath: '',
            warnings: `Near-duplicate of existing client "${normalizedMatch}" — skipped`,
          });
          console.log(`${customer} | SKIPPED (near-duplicate of existing "${normalizedMatch}")`);
          continue;
        }

        // --- Dropbox resolution ---
        let dropboxPath = '';
        let dropboxWarning = '';
        const exactDropboxPath = resolveDropboxFolderPathSync('', customer, false);
        let topFolderName = (await dropboxFolderExists(dbx, exactDropboxPath)) ? customer : null;

        if (!topFolderName) {
          const key = normalizeName(customer);
          const candidates = dropboxNormalizedMap.get(key) || [];
          if (candidates.length > 0) topFolderName = candidates[0];
        }

        if (topFolderName) {
          const topFolderPath = resolveDropboxFolderPathSync('', topFolderName, false);
          const children = await dropboxListFolder(dbx, topFolderPath);
          const childFolders = children.filter((e) => e['.tag'] === 'folder');
          const exactPayroll = childFolders.find((f) => f.name.toLowerCase() === 'payroll files');
          const variantPayroll = childFolders.find((f) => f.name.toLowerCase().includes('payroll'));
          const payrollFolder = exactPayroll || variantPayroll;

          dropboxPath = payrollFolder ? `${topFolderName}/${payrollFolder.name}` : topFolderName;
        } else {
          dropboxPath = '';
          dropboxWarning = 'Dropbox folder not found';
        }

        // --- ShareFile resolution ---
        let shareFilePath = '';
        const fullShareFilePath = `${shareFileRootPath}/${customer}`;
        const exact = await shareFileExactMatch(apiBase, authHeaders, rootId, fullShareFilePath);
        if (exact) {
          shareFilePath = customer;
        } else {
          const key = normalizeName(customer);
          const candidates = shareFileNormalizedMap.get(key) || [];
          if (candidates.length > 0) shareFilePath = candidates[0];
        }

        // --- Create Client record ---
        const clientDoc = new Client({
          name: customer,
          status: 'inactive',
          dropboxPath,
          dropboxPathIsAbsolute: false,
          shareFilePath,
          fein: (row[idx.fein] || '').trim(),
          wotcFormUrl: (row[idx.wotcFormUrl] || '').trim(),
          emailSalutation: (row[idx.emailSalutation] || '').trim(),
          complianceReportEmailDistribution: (row[idx.complianceReportEmailDistribution] || '').trim(),
          folderSetupWarnings: dropboxWarning ? [dropboxWarning] : [],
        });
        await clientDoc.save();
        existingNameSet.add(customer.toLowerCase());

        results.push({
          customer,
          outcome: 'created',
          dropboxPath,
          shareFilePath,
          warnings: dropboxWarning,
        });
        console.log(
          `${customer} | CREATED | dropboxPath="${dropboxPath}" | shareFilePath="${shareFilePath}"${
            dropboxWarning ? ` | WARNING: ${dropboxWarning}` : ''
          }`
        );
      } catch (error) {
        const message = formatError(error);
        errors.push({ customer, message });
        results.push({ customer, outcome: 'error', dropboxPath: '', shareFilePath: '', warnings: message });
        console.error(`${customer} | ERROR: ${message}`);
      }
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    const outLines = ['Customer,Outcome,dropboxPath,shareFilePath,Warnings'];
    for (const r of results) {
      outLines.push(
        [csvEscape(r.customer), r.outcome, csvEscape(r.dropboxPath), csvEscape(r.shareFilePath), csvEscape(r.warnings)].join(',')
      );
    }
    fs.writeFileSync(OUTPUT_PATH, outLines.join('\n') + '\n', 'utf8');

    const created = results.filter((r) => r.outcome === 'created');
    const skipped = results.filter((r) => r.outcome === 'skipped_exists');
    const skippedNearDup = results.filter((r) => r.outcome === 'skipped_near_duplicate');
    const createdWithDropboxWarning = created.filter((r) => r.warnings);
    const createdWithEmptyShareFile = created.filter((r) => !r.shareFilePath);

    console.log('\n--- SUMMARY ---');
    console.log(`Total processed: ${dataRows.length}`);
    console.log(`Created: ${created.length}`);
    console.log(`Skipped (already existed, exact name): ${skipped.length}`);
    if (skipped.length) skipped.forEach((r) => console.log(`  - ${r.customer}`));
    console.log(`Skipped (near-duplicate of existing client, normalized name match): ${skippedNearDup.length}`);
    if (skippedNearDup.length) skippedNearDup.forEach((r) => console.log(`  - ${r.customer}: ${r.warnings}`));
    console.log(`Created with a Dropbox warning: ${createdWithDropboxWarning.length}`);
    if (createdWithDropboxWarning.length) {
      createdWithDropboxWarning.forEach((r) => console.log(`  - ${r.customer} (dropboxPath="${r.dropboxPath}", warning="${r.warnings}")`));
    }
    console.log(`Created with empty shareFilePath: ${createdWithEmptyShareFile.length}`);
    console.log(`Errors: ${errors.length}`);
    if (errors.length) errors.forEach((e) => console.log(`  - ${e.customer}: ${e.message}`));
    console.log(`\nFull per-client results written to: ${OUTPUT_PATH}`);
  } catch (error) {
    console.error('FATAL ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
})();
