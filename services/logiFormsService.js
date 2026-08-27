const MOCK_LOGIFORMS_RECORDS = [
  { ssn: '111-11-1111', status: 'New', dateSubmitted: '2024-01-05', ein: '12-3456789' },
  { ssn: '111-11-1112', status: 'DNQ', dateSubmitted: '2024-01-06', ein: '12-3456789' },
  { ssn: '111-11-1113', status: 'Qualified', dateSubmitted: '2024-01-07', ein: '12-3456789' },
  { ssn: '111-11-1114', status: '', dateSubmitted: '2024-01-08', ein: '12-3456789' },
  { ssn: '111-11-1115', status: 'Processed', dateSubmitted: '2024-01-09', ein: '12-3456789' },
  { ssn: '222-22-2221', status: 'Certified', dateSubmitted: '2024-01-10', ein: '98-7654321' },
  { ssn: '222-22-2222', status: 'Denial', dateSubmitted: '2024-01-11', ein: '98-7654321' },
  { ssn: '222-22-2223', status: 'Awaiting Docs', dateSubmitted: '2024-01-12', ein: '98-7654321' },
  { ssn: '222-22-2224', status: 'New', dateSubmitted: '2024-01-13', ein: '98-7654321' },
  { ssn: '222-22-2225', status: '', dateSubmitted: '2024-01-14', ein: '98-7654321' },
  { ssn: '333-33-3331', status: 'Qualified', dateSubmitted: '2024-01-15', ein: '11-2233445' },
  { ssn: '333-33-3332', status: 'DNQ', dateSubmitted: '2024-01-16', ein: '11-2233445' },
  { ssn: '333-33-3333', status: 'Processed', dateSubmitted: '2024-01-17', ein: '11-2233445' },
  { ssn: '333-33-3334', status: 'Certified', dateSubmitted: '2024-01-18', ein: '11-2233445' },
  { ssn: '333-33-3335', status: 'New', dateSubmitted: '2024-01-19', ein: '11-2233445' },
];

const isMockMode = (apiKey) => {
  if (process.env.LOGIFORMS_MOCK_MODE === 'true') return true;
  const trimmed = String(apiKey ?? '').trim();
  return trimmed === '' || trimmed.toLowerCase() === 'placeholder';
};

const buildRequestUrl = (apiUrl, dateRange) => {
  const url = new URL(apiUrl);
  if (dateRange?.from) url.searchParams.set('from', dateRange.from);
  if (dateRange?.to) url.searchParams.set('to', dateRange.to);
  return url.toString();
};

const normalizeLogiFormsResponse = (data) => {
  const records = Array.isArray(data) ? data : data?.records || data?.data || data?.results || [];
  return records.map((record) => ({
    ssn: record.ssn ?? record.SSN ?? '',
    status: record.status ?? record.Status ?? '',
    dateSubmitted: record.dateSubmitted ?? record.date_submitted ?? record.DateSubmitted ?? '',
    ein: record.ein ?? record.EIN ?? record.fein ?? record.FEIN ?? '',
  }));
};

const fetchLogiFormsData = async (apiUrl, apiKey, dateRange) => {
  if (isMockMode(apiKey)) {
    return MOCK_LOGIFORMS_RECORDS;
  }

  if (!apiUrl) {
    throw new Error('LogiForms API failed: LOGIFORMS_API_URL is not set.');
  }

  let response;
  try {
    response = await fetch(buildRequestUrl(apiUrl, dateRange), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (error) {
    throw new Error(`LogiForms API failed: network error - ${error.message}`);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`LogiForms API failed: HTTP ${response.status} - ${body}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`LogiForms API failed: could not parse response as JSON - ${error.message}`);
  }

  return normalizeLogiFormsResponse(data);
};

const normalizeFein = (value) => String(value ?? '').replace(/[^0-9]/g, '');

const fetchLogiFormsDataForClient = async (fein, apiUrl, apiKey, dateRange) => {
  const allRecords = await fetchLogiFormsData(apiUrl, apiKey, dateRange);
  const normalizedFein = normalizeFein(fein);
  return allRecords.filter((record) => normalizeFein(record.ein) === normalizedFein);
};

module.exports = { fetchLogiFormsData, fetchLogiFormsDataForClient };
