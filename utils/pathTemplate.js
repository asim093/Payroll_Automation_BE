const PLACEHOLDER = '{Client Name}';


const substituteTemplate = (template, clientFolderSegment) => {
  const value = template || '';
  return value.includes(PLACEHOLDER) ? value.split(PLACEHOLDER).join(clientFolderSegment) : value;
};

module.exports = { substituteTemplate, PLACEHOLDER };
