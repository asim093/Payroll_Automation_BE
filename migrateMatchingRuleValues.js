// Normalizes matching-rule values flagged by diagnoseMatchingRuleValues.js:
// rewrites each client's matchingRules arrays through classifyMatchValue
// (lowercase, strip a leading "@", re-bucket email vs domain), drops invalid
// entries, then re-runs syncLegacyRulesForClient so the MatchingRule rows are
// regenerated clean. Manual MatchingRule rows whose value is non-normalized or
// whose type is wrong for their shape are corrected in place.
//
//   node migrateMatchingRuleValues.js            (dry run — prints every change)
//   node migrateMatchingRuleValues.js --apply    (writes)
//
// Idempotent. Only touches rows the diagnostic would flag.

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const MatchingRule = require('./models/MatchingRule');
const { syncLegacyRulesForClient } = require('./services/matchingRuleSyncService');
const { classifyMatchValue, deriveRuleType } = require('./utils/matchValue');

const APPLY = process.argv.includes('--apply');

// Re-bucket a client's email/domain arrays into normalized, correctly-typed sets.
const rebuild = (matchingRules) => {
  const emails = new Set();
  const domains = new Set();
  const dropped = [];
  for (const raw of matchingRules?.emailAddresses || []) {
    const { kind, value } = classifyMatchValue(raw);
    if (kind === 'email') emails.add(value);
    else if (kind === 'domain') domains.add(value);
    else dropped.push(raw);
  }
  for (const raw of matchingRules?.domains || []) {
    const { kind, value } = classifyMatchValue(raw);
    if (kind === 'domain') domains.add(value);
    else if (kind === 'email') emails.add(value);
    else dropped.push(raw);
  }
  return { emailAddresses: [...emails], domains: [...domains], dropped };
};

const arraysEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const run = async () => {
  await connectDB();
  const changes = [];

  // ---- client.matchingRules ----
  const clients = await Client.find();
  for (const client of clients) {
    const before = {
      emailAddresses: [...(client.matchingRules?.emailAddresses || [])],
      domains: [...(client.matchingRules?.domains || [])],
    };
    const rebuilt = rebuild(client.matchingRules);
    if (arraysEqual(before.emailAddresses, rebuilt.emailAddresses) && arraysEqual(before.domains, rebuilt.domains)) {
      continue;
    }
    changes.push({
      kind: 'client',
      name: client.name,
      id: String(client._id),
      before,
      after: { emailAddresses: rebuilt.emailAddresses, domains: rebuilt.domains },
      dropped: rebuilt.dropped,
    });
    if (APPLY) {
      client.matchingRules = {
        ...(client.matchingRules || {}),
        emailAddresses: rebuilt.emailAddresses,
        domains: rebuilt.domains,
      };
      await client.save();
      await syncLegacyRulesForClient(await Client.findById(client._id));
    }
  }

  // ---- manual MatchingRule rows (legacy_sync ones are regenerated above) ----
  const manualRules = await MatchingRule.find({ source: 'manual' });
  for (const rule of manualRules) {
    let nextType = rule.type;
    let nextValue = rule.value;
    if (rule.type === 'exact_email' || rule.type === 'domain') {
      const { kind, value } = classifyMatchValue(rule.value);
      if (kind === 'invalid') {
        changes.push({ kind: 'manual_rule_invalid', id: String(rule._id), clientId: String(rule.clientId), value: rule.value });
        if (APPLY) await MatchingRule.deleteOne({ _id: rule._id });
        continue;
      }
      nextType = deriveRuleType(rule.value);
      nextValue = value;
    } else {
      nextValue = String(rule.value || '').trim().toLowerCase();
    }
    if (nextType === rule.type && nextValue === rule.value) continue;
    changes.push({
      kind: 'manual_rule',
      id: String(rule._id),
      clientId: String(rule.clientId),
      before: { type: rule.type, value: rule.value },
      after: { type: nextType, value: nextValue },
    });
    if (APPLY) {
      rule.type = nextType;
      rule.value = nextValue;
      await rule.save();
    }
  }

  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'} — ${changes.length} change(s)\n`);
  for (const c of changes) {
    if (c.kind === 'client') {
      console.log(`client "${c.name}" (${c.id})`);
      console.log(`  emailAddresses: ${JSON.stringify(c.before.emailAddresses)} -> ${JSON.stringify(c.after.emailAddresses)}`);
      console.log(`  domains:        ${JSON.stringify(c.before.domains)} -> ${JSON.stringify(c.after.domains)}`);
      if (c.dropped.length) console.log(`  DROPPED (invalid): ${JSON.stringify(c.dropped)}`);
    } else if (c.kind === 'manual_rule') {
      console.log(`manual MatchingRule ${c.id} (client ${c.clientId}): ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
    } else if (c.kind === 'manual_rule_invalid') {
      console.log(`manual MatchingRule ${c.id} (client ${c.clientId}): DELETED — invalid value ${JSON.stringify(c.value)}`);
    }
  }
  if (!APPLY && changes.length) console.log('\nRe-run with --apply to write these changes.');

  await mongoose.disconnect();
  process.exit(0);
};

run().catch((error) => {
  console.error('migrateMatchingRuleValues ERROR:', error.message);
  process.exit(2);
});
