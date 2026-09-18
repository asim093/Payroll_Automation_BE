const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../../config/db');
const Client = require('../../models/Client');


const CSV_PATH = path.join(__dirname, '..', '..', 'clients_active_v3_final.csv');
const OUTPUT_PATH = path.join(__dirname, '..', '..', 'data', 'fieldUpdateResults.csv');

const FREQUENCY_ENUM = ['Monthly', 'Quarterly', 'Annually'];

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

const normalizeName = (name) => {
  let normalized = String(name || '').toLowerCase().replace(/[.,'']/g, '').trim();
  normalized = normalized.replace(/\b(inc|llc|ltd|corp|co)\b\.?\s*$/i, '').trim();
  return normalized.replace(/\s+/g, ' ');
};

const mapFrequency = (raw) => {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { value: undefined, valid: true };
  const match = FREQUENCY_ENUM.find((v) => v.toLowerCase() === trimmed.toLowerCase());
  return match ? { value: match, valid: true } : { value: undefined, valid: false, raw: trimmed };
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
    const col = (name) => header.indexOf(name);
    const idx = {
      customer: col('Customer'),
      fein: col('FEIN'),
      frequency: col('Frequency'),
      emailForMatching: col('Email_ForMatching'),
      domainForMatching: col('Domain_ForMatching'),
      wotcEmailSalutation: col('WOTC_Email_Salutation'),
      wotcEmailDistribution: col('WOTC_Email_Distribution'),
      wotcFormUrl: col('WOTC_Form_URL'),
    };
    for (const [key, value] of Object.entries(idx)) {
      if (value === -1) throw new Error(`CSV missing expected column for "${key}"`);
    }

    const csvRows = rows.slice(1);
    const exactMap = new Map();
    const normalizedMap = new Map();
    for (const row of csvRows) {
      const name = (row[idx.customer] || '').trim();
      if (!name) continue;
      exactMap.set(name.toLowerCase(), row);
      const normKey = normalizeName(name);
      if (!normalizedMap.has(normKey)) normalizedMap.set(normKey, row);
    }

    const allClients = await Client.find({});
    console.log(`Loaded ${allClients.length} existing Client records. Matching against ${csvRows.length} CSV rows.\n`);

    const results = [];
    let invalidFrequencyCount = 0;

    for (const client of allClients) {
      const exact = exactMap.get(client.name.toLowerCase());
      const row = exact || normalizedMap.get(normalizeName(client.name));

      if (!row) {
        results.push({ customer: client.name, matched: 'no', filled: '', alreadySet: '', note: 'No matching CSV row — left untouched' });
        continue;
      }

      const filled = [];
      const alreadySet = [];
      const notes = [];

      // complianceReportFrequency — only if currently unset
      if (!client.complianceReportFrequency) {
        const { value, valid, raw } = mapFrequency(row[idx.frequency]);
        if (value) {
          client.complianceReportFrequency = value;
          filled.push(`complianceReportFrequency=${value}`);
        } else if (!valid) {
          invalidFrequencyCount += 1;
          notes.push(`Frequency "${raw}" did not match enum — left unset`);
        }
      } else {
        alreadySet.push('complianceReportFrequency');
      }

      // matchingRules.emailAddresses — additive, dedup
      const emailForMatching = (row[idx.emailForMatching] || '').trim();
      if (emailForMatching) {
        if (!client.matchingRules) client.matchingRules = { emailAddresses: [], domains: [] };
        if (!client.matchingRules.emailAddresses) client.matchingRules.emailAddresses = [];
        const alreadyHasEmail = client.matchingRules.emailAddresses.some(
          (e) => e.toLowerCase() === emailForMatching.toLowerCase()
        );
        if (!alreadyHasEmail) {
          client.matchingRules.emailAddresses.push(emailForMatching);
          filled.push(`matchingRules.emailAddresses+=${emailForMatching}`);
        } else {
          alreadySet.push('matchingRules.emailAddresses (already present)');
        }
      }

      // matchingRules.domains — additive, dedup, only if non-empty in CSV
      const domainForMatching = (row[idx.domainForMatching] || '').trim();
      if (domainForMatching) {
        if (!client.matchingRules) client.matchingRules = { emailAddresses: [], domains: [] };
        if (!client.matchingRules.domains) client.matchingRules.domains = [];
        const alreadyHasDomain = client.matchingRules.domains.some(
          (d) => d.toLowerCase() === domainForMatching.toLowerCase()
        );
        if (!alreadyHasDomain) {
          client.matchingRules.domains.push(domainForMatching);
          filled.push(`matchingRules.domains+=${domainForMatching}`);
        } else {
          alreadySet.push('matchingRules.domains (already present)');
        }
      } else {
        notes.push('Domain_ForMatching blank in CSV — left empty (no domain guessed)');
      }

      // wotcFormUrl — only if currently empty
      const wotcFormUrl = (row[idx.wotcFormUrl] || '').trim();
      if (!client.wotcFormUrl) {
        if (wotcFormUrl) {
          client.wotcFormUrl = wotcFormUrl;
          filled.push('wotcFormUrl');
        }
      } else {
        alreadySet.push('wotcFormUrl');
      }

      // emailSalutation — only if currently empty
      const salutation = (row[idx.wotcEmailSalutation] || '').trim();
      if (!client.emailSalutation) {
        if (salutation) {
          client.emailSalutation = salutation;
          filled.push('emailSalutation');
        }
      } else {
        alreadySet.push('emailSalutation');
      }

      // complianceReportEmailDistribution — only if currently empty
      const distribution = (row[idx.wotcEmailDistribution] || '').trim();
      if (!client.complianceReportEmailDistribution) {
        if (distribution) {
          client.complianceReportEmailDistribution = distribution;
          filled.push('complianceReportEmailDistribution');
        }
      } else {
        alreadySet.push('complianceReportEmailDistribution');
      }

      // fein — only if currently empty
      const fein = (row[idx.fein] || '').trim();
      if (!client.fein) {
        if (fein) {
          client.fein = fein;
          filled.push('fein');
        }
      } else {
        alreadySet.push('fein');
      }

      if (filled.length > 0) {
        await client.save();
      }

      results.push({
        customer: client.name,
        matched: exact ? 'exact' : 'normalized',
        matchedCsvName: row[idx.customer],
        filled: filled.join('; '),
        alreadySet: alreadySet.join('; '),
        note: notes.join('; '),
      });

      console.log(
        `${client.name}${exact ? '' : ` (matched via normalized name to CSV "${row[idx.customer]}")`} | Filled: ${
          filled.length ? filled.join(', ') : '(none)'
        }`
      );
    }

    fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
    const outLines = ['Customer,Matched,MatchedCsvName,FieldsFilled,FieldsAlreadySet,Notes'];
    for (const r of results) {
      outLines.push(
        [
          csvEscape(r.customer),
          r.matched,
          csvEscape(r.matchedCsvName || ''),
          csvEscape(r.filled),
          csvEscape(r.alreadySet),
          csvEscape(r.note),
        ].join(',')
      );
    }
    fs.writeFileSync(OUTPUT_PATH, outLines.join('\n') + '\n', 'utf8');

    const matched = results.filter((r) => r.matched !== 'no');
    const unmatched = results.filter((r) => r.matched === 'no');
    const viaNormalized = results.filter((r) => r.matched === 'normalized');
    const withFieldsFilled = results.filter((r) => r.filled);

    console.log('\n--- SUMMARY ---');
    console.log(`Total existing Client records: ${allClients.length}`);
    console.log(`Matched to a CSV row: ${matched.length}`);
    console.log(`  - matched via normalized/fuzzy name: ${viaNormalized.length}`);
    if (viaNormalized.length) viaNormalized.forEach((r) => console.log(`    - "${r.customer}" <- CSV "${r.matchedCsvName}"`));
    console.log(`Not matched to any CSV row (left untouched): ${unmatched.length}`);
    if (unmatched.length) unmatched.forEach((r) => console.log(`  - ${r.customer}`));
    console.log(`Records with at least one field filled: ${withFieldsFilled.length}`);
    console.log(`Invalid/unmapped Frequency values encountered: ${invalidFrequencyCount}`);
    console.log(`\nFull per-client results written to: ${OUTPUT_PATH}`);
  } catch (error) {
    console.error('FATAL ERROR:', error.message);
  } finally {
    await mongoose.connection.close();
  }
})();
