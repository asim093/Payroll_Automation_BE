const MERGE_FIELD_PATTERN = /\{\{\s*(Client Name|WOTC Form URL|Salutation)\s*\}\}/g;

const applyMergeFields = (text, values) => {
  if (!text) return '';
  return text.replace(MERGE_FIELD_PATTERN, (match, fieldName) => {
    const value = values[fieldName];
    return value === undefined || value === null ? '' : String(value);
  });
};

module.exports = { applyMergeFields, MERGE_FIELD_PATTERN };
