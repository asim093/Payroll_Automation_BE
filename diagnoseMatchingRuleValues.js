// Read-only diagnostic: scans every client's matchingRules arrays and the whole
// MatchingRule collection for values that classifyMatchValue would flag —
// @-prefixed domains, values whose stored type is wrong for their shape,
// invalid/garbage values, non-normalized casing/whitespace, and orphaned rules.
//
//   node diagnoseMatchingRuleValues.js
//
// Touches nothing. Exit 1 if anything is flagged, 0 if clean.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const MatchingRule = require('./models/MatchingRule');
const { classifyMatchValue, deriveRuleType, normalizeMatchValue } = require('./utils/matchValue');

const findings = [];
const add = (category, where, detail) => findings.push({ category, where, ...detail });

const inspectValue = (raw) => {
  const { kind, value: normalized } = classifyMatchValue(raw);
  const trimmedLower = String(raw || '').trim().toLowerCase();
  return {
    kind,
    normalized,
    derivedType: deriveRuleType(raw), // null for invalid / subject
    isNormalized: String(raw) === normalized,
    hasLeadingAt: String(raw || '').trim().startsWith('@'),
    trimmedLower,
  };
};

const run = async () => {
  await connectDB();

  const clients = await Client.find().select('name matchingRules').lean();
  const clientIds = new Set(clients.map((c) => String(c._id)));

  // ---- client.matchingRules arrays ----
  for (const client of clients) {
    const mr = client.matchingRules || {};
    (mr.emailAddresses || []).forEach((raw) => {
      const v = inspectValue(raw);
      if (v.kind === 'invalid') {
        add('invalid_value', `client "${client.name}".matchingRules.emailAddresses`, { value: raw });
      } else if (v.kind === 'domain') {
        add('wrong_array', `client "${client.name}".matchingRules.emailAddresses`, {
          value: raw, note: `is a domain (${v.normalized}); belongs in .domains`,
        });
      } else if (!v.isNormalized) {
        add('not_normalized', `client "${client.name}".matchingRules.emailAddresses`, {
          value: raw, corrected: v.normalized,
        });
      }
    });
    (mr.domains || []).forEach((raw) => {
      const v = inspectValue(raw);
      if (v.kind === 'invalid') {
        add('invalid_value', `client "${client.name}".matchingRules.domains`, { value: raw });
      } else if (v.kind === 'email') {
        add('wrong_array', `client "${client.name}".matchingRules.domains`, {
          value: raw, note: 'is a full email address; belongs in .emailAddresses',
        });
      } else if (v.hasLeadingAt || !v.isNormalized) {
        add('at_prefixed_or_not_normalized', `client "${client.name}".matchingRules.domains`, {
          value: raw, corrected: v.normalized,
        });
      }
    });
  }

  // ---- MatchingRule collection ----
  const rules = await MatchingRule.find().lean();
  for (const rule of rules) {
    const label = `MatchingRule ${rule._id} (client ${rule.clientId}, source ${rule.source}, type ${rule.type})`;

    if (!clientIds.has(String(rule.clientId))) {
      add('orphan_rule', label, { value: rule.value, note: 'clientId no longer exists' });
      continue;
    }

    if (rule.type === 'subject_keyword' || rule.type === 'notification_pattern') {
      const lower = String(rule.value || '').trim().toLowerCase();
      if (String(rule.value) !== lower) {
        add('not_normalized', label, { value: rule.value, corrected: lower });
      }
      continue;
    }

    // exact_email / domain
    const v = inspectValue(rule.value);
    if (v.kind === 'invalid') {
      add('invalid_value', label, { value: rule.value, note: 'not a valid email or domain' });
    } else if (v.derivedType !== rule.type) {
      add('miscategorized_type', label, {
        value: rule.value,
        note: `stored as ${rule.type}, but its shape is ${v.derivedType} (corrected value: ${v.normalized})`,
      });
    } else if (!v.isNormalized) {
      add('not_normalized', label, { value: rule.value, corrected: v.normalized });
    }
  }

  // ---- report ----
  console.log(`Matching-rule value diagnostic — ${clients.length} clients, ${rules.length} MatchingRule rows\n`);
  if (findings.length === 0) {
    console.log('SUMMARY: CLEAN — no flagged values.');
    await mongoose.disconnect();
    process.exit(0);
  }

  const byCategory = findings.reduce((acc, f) => {
    (acc[f.category] = acc[f.category] || []).push(f);
    return acc;
  }, {});
  for (const [category, items] of Object.entries(byCategory)) {
    console.log(`\n[${category}] — ${items.length}`);
    for (const item of items) {
      console.log(`  ${item.where}`);
      console.log(`    value: ${JSON.stringify(item.value)}${item.corrected !== undefined ? `  ->  ${JSON.stringify(item.corrected)}` : ''}`);
      if (item.note) console.log(`    ${item.note}`);
    }
  }
  console.log(`\nSUMMARY: ${findings.length} flagged item(s) across ${Object.keys(byCategory).length} categor(ies).`);

  await mongoose.disconnect();
  process.exit(1);
};

run().catch((error) => {
  console.error('diagnoseMatchingRuleValues ERROR:', error.message);
  process.exit(2);
});
