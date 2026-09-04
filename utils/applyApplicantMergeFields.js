const APPLICANT_MERGE_FIELD_PATTERN = /\{\{\s*(Customer|WOTC Form URL)\s*\}\}/g;

const applyApplicantMergeFields = (text, values) => {
  if (!text) return '';
  return text.replace(APPLICANT_MERGE_FIELD_PATTERN, (match, fieldName) => {
    const value = values ? values[fieldName] : undefined;
    return value === undefined || value === null ? '' : String(value);
  });
};

module.exports = { applyApplicantMergeFields, APPLICANT_MERGE_FIELD_PATTERN };
