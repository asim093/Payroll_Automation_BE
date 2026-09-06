// Classifies a matching-rule / client-contact value by its shape. Kept in sync
// with the frontend's src/utils/matchValue.js (same rules, same normalization);
// testMatchValue.js locks the parity.
//
//   'email'   -> "local@domain.tld"            -> an exact_email rule
//   'domain'  -> "domain.tld" or "@domain.tld" -> a domain rule
//   'invalid' -> anything else

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^(?=.{1,253}$)(?:${LABEL}\\.)+[a-z][a-z0-9-]{0,62}$`);
const EMAIL_LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;

const isPlausibleDomain = (value) => DOMAIN_RE.test(String(value || '').trim().toLowerCase());

// Returns { kind, value, domain }. `value` is the normalized form to store
// (lowercased, trimmed, leading "@" removed for the domain form).
const classifyMatchValue = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || /\s/.test(value)) return { kind: 'invalid', value, domain: null };

  if (value.startsWith('@')) {
    const domain = value.slice(1);
    return isPlausibleDomain(domain)
      ? { kind: 'domain', value: domain, domain }
      : { kind: 'invalid', value, domain: null };
  }

  const atCount = (value.match(/@/g) || []).length;
  if (atCount === 1) {
    const [local, domain] = value.split('@');
    return EMAIL_LOCAL_RE.test(local) && isPlausibleDomain(domain)
      ? { kind: 'email', value, domain }
      : { kind: 'invalid', value, domain: null };
  }
  if (atCount === 0) {
    return isPlausibleDomain(value)
      ? { kind: 'domain', value, domain: value }
      : { kind: 'invalid', value, domain: null };
  }
  return { kind: 'invalid', value, domain: null };
};

// -> 'exact_email' | 'domain' | null
const deriveRuleType = (raw) => {
  const kind = classifyMatchValue(raw).kind;
  if (kind === 'email') return 'exact_email';
  if (kind === 'domain') return 'domain';
  return null;
};

const normalizeMatchValue = (raw) => classifyMatchValue(raw).value;

// Re-bucket a client's { emailAddresses, domains } into normalized, correctly
// typed, de-duplicated sets. Invalid values are dropped. Other keys pass through.
const normalizeClientMatchingRules = (matchingRules = {}) => {
  const emails = new Set();
  const domains = new Set();
  [...(matchingRules.emailAddresses || []), ...(matchingRules.domains || [])].forEach((raw) => {
    const { kind, value } = classifyMatchValue(raw);
    if (kind === 'email') emails.add(value);
    else if (kind === 'domain') domains.add(value);
  });
  return { ...matchingRules, emailAddresses: [...emails], domains: [...domains] };
};

module.exports = {
  classifyMatchValue,
  deriveRuleType,
  normalizeMatchValue,
  normalizeClientMatchingRules,
  isPlausibleDomain,
};
