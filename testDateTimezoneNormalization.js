require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const XLSX = require('xlsx');
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { parsePayrollFile } = require('./services/payrollFileParserService');
const { getWeekEndingSunday } = require('./services/complianceCalculationService');
const { normalizeToUtcCalendarDate } = require('./utils/dateOnly');

const TIMEZONES = ['Asia/Karachi', 'UTC', 'America/Los_Angeles'];

const TEST_ROWS = [
  { ssn: '900-00-0001', name: 'Mon Aug 03', date: '08/03/2026', expectStart: '2026-08-03', expectWE: '2026-08-09' },
  { ssn: '900-00-0002', name: 'Thu Aug 06', date: '08/06/2026', expectStart: '2026-08-06', expectWE: '2026-08-09' },
  { ssn: '900-00-0003', name: 'Sat Aug 08', date: '08/08/2026', expectStart: '2026-08-08', expectWE: '2026-08-09' },
  { ssn: '900-00-0004', name: 'Sun Aug 09', date: '08/09/2026', expectStart: '2026-08-09', expectWE: '2026-08-09' },
  { ssn: '900-00-0005', name: 'Mon Aug 10', date: '08/10/2026', expectStart: '2026-08-10', expectWE: '2026-08-16' },
  { ssn: '900-00-0006', name: 'Mon Aug 31', date: '08/31/2026', expectStart: '2026-08-31', expectWE: '2026-09-06' },
  { ssn: '900-00-0007', name: 'Tue Dec 29', date: '12/29/2026', expectStart: '2026-12-29', expectWE: '2027-01-03' },
];

const SERIAL_CASES = [
  { input: 46240, expect: '2026-08-06' },
  { input: 46240.9, expect: '2026-08-06' },
  { input: 46240.00013888889, expect: '2026-08-06' },
  { input: 46239.999, expect: '2026-08-05' },
];

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
const serialFor = (iso) => Math.round((new Date(`${iso}T00:00:00Z`).getTime() - EXCEL_EPOCH) / 86400000);
const isoDay = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null);

function buildFixtures(dir) {
  const header = ['Start Date', 'Employee Name', 'SSN', 'Email'];

  const csvPath = path.join(dir, 'payroll.csv');
  fs.writeFileSync(
    csvPath,
    [header.join(','), ...TEST_ROWS.map((r) => `${r.date},${r.name},${r.ssn},x@zz-test.local`)].join('\r\n') + '\r\n'
  );

  const xlsxPath = path.join(dir, 'payroll.xlsx');
  const aoa = [
    header,
    ...TEST_ROWS.map((r) => [serialFor(r.expectStart), r.name, r.ssn, 'x@zz-test.local']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  for (let i = 0; i < TEST_ROWS.length; i += 1) {
    const cell = ws[`A${i + 2}`];
    if (cell) cell.z = 'm/d/yy';
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
  XLSX.writeFile(wb, xlsxPath);

  return { csvPath, xlsxPath };
}

async function runWorker() {
  await connectDB();
  const tz = process.env.TZ || '(unset)';
  const offsetMin = new Date().getTimezoneOffset();
  const csvPath = process.env.FIXTURE_CSV;
  const xlsxPath = process.env.FIXTURE_XLSX;

  const shape = (rows) =>
    rows.map((row) => ({ ssn: row.ssn, startDate: isoDay(row.startDate), we: isoDay(getWeekEndingSunday(row.startDate)) }));

  const csvParsed = shape(await parsePayrollFile(csvPath));
  const xlsxParsed = shape(await parsePayrollFile(xlsxPath));
  const serials = SERIAL_CASES.map((c) => ({ input: c.input, out: isoDay(normalizeToUtcCalendarDate(c.input)) }));

  await mongoose.disconnect();
  process.stdout.write(`__RESULT__${JSON.stringify({ tz, offsetMin, csv: csvParsed, xlsx: xlsxParsed, serials })}__END__`);
}

async function runDriver() {
  let failed = false;
  const check = (label, pass, detail) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${!pass && detail ? `  -> ${detail}` : ''}`);
    if (!pass) failed = true;
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tzdate-'));
  const { csvPath, xlsxPath } = buildFixtures(dir);
  console.log(`fixtures: ${csvPath} , ${xlsxPath}\n`);

  const results = {};
  for (const tz of TIMEZONES) {
    const raw = execFileSync(process.execPath, [__filename, '--worker'], {
      env: { ...process.env, TZ: tz, FIXTURE_CSV: csvPath, FIXTURE_XLSX: xlsxPath },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const match = raw.match(/__RESULT__([\s\S]*?)__END__/);
    if (!match) throw new Error(`worker for ${tz} produced no result payload:\n${raw}`);
    results[tz] = JSON.parse(match[1]);
    console.log(`[${tz}] offsetMin=${results[tz].offsetMin}`);
  }
  console.log('');

  const ref = results[TIMEZONES[0]];

  for (const tz of TIMEZONES.slice(1)) {
    check(`${tz}: CSV parse byte-identical to ${TIMEZONES[0]}`, JSON.stringify(results[tz].csv) === JSON.stringify(ref.csv), JSON.stringify(results[tz].csv));
    check(`${tz}: XLSX parse byte-identical to ${TIMEZONES[0]}`, JSON.stringify(results[tz].xlsx) === JSON.stringify(ref.xlsx), JSON.stringify(results[tz].xlsx));
    check(`${tz}: serial cases byte-identical to ${TIMEZONES[0]}`, JSON.stringify(results[tz].serials) === JSON.stringify(ref.serials), JSON.stringify(results[tz].serials));
  }

  check('CSV and XLSX inputs produce the same parsed result', JSON.stringify(ref.csv) === JSON.stringify(ref.xlsx));

  for (const expected of TEST_ROWS) {
    const bareSsn = expected.ssn.replace(/-/g, '');
    const csvRow = ref.csv.find((r) => r.ssn === bareSsn);
    const xlsxRow = ref.xlsx.find((r) => r.ssn === bareSsn);
    check(`${expected.name}: startDate = ${expected.expectStart} (CSV)`, csvRow.startDate === expected.expectStart, `got ${csvRow.startDate}`);
    check(`${expected.name}: startDate = ${expected.expectStart} (XLSX)`, xlsxRow.startDate === expected.expectStart, `got ${xlsxRow.startDate}`);
    check(`${expected.name}: W/E = ${expected.expectWE} (CSV)`, csvRow.we === expected.expectWE, `got ${csvRow.we}`);
    check(`${expected.name}: W/E = ${expected.expectWE} (XLSX)`, xlsxRow.we === expected.expectWE, `got ${xlsxRow.we}`);
  }

  for (const s of SERIAL_CASES) {
    const got = ref.serials.find((x) => x.input === s.input).out;
    check(`serial ${s.input} -> ${s.expect}`, got === s.expect, `got ${got}`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${failed ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'} across ${TIMEZONES.join(', ')}`);
  process.exit(failed ? 1 : 0);
}

if (process.argv.includes('--worker')) {
  runWorker().catch((e) => { console.error('WORKER ERROR:', e); process.exit(1); });
} else {
  runDriver().catch((e) => { console.error('DRIVER ERROR:', e); process.exit(1); });
}
