# Payroll Automation — Backend

## Known Security Considerations

### `xlsx` (SheetJS) — Prototype Pollution / ReDoS (accepted risk)

`services/payrollFileParserService.js` uses the `xlsx` package (npm registry
version, currently 0.18.5) to parse payroll files. This version has two
known high-severity advisories with **no fix available via npm**:

- Prototype Pollution — https://github.com/advisories/GHSA-4r6h-8v6p-xvw6
- Regular Expression Denial of Service (ReDoS) — https://github.com/advisories/GHSA-5pgg-2g8v-p4x9

SheetJS stopped publishing patched builds to the public npm registry and
moved them to their own CDN (`cdn.sheetjs.com`) instead.

**Current risk assessment:** accepted. Payroll files parsed by this service
come from a semi-trusted source (known, existing clients' own payroll
systems via ShareFile/Dropbox) — not arbitrary public uploads.

**Revisit this if:** a public-facing file-upload feature is ever added
(anything letting an untrusted/external party submit a file that reaches
this parser). At that point, switch to `exceljs`, or pull the patched
`xlsx` build from SheetJS's own CDN instead of the npm registry version.

### `exceljs` -> `uuid` transitive dependency (moderate, accepted risk)

`services/complianceReportGeneratorService.js` uses `exceljs` (currently
4.4.0, the latest stable release) to write the generated report files.
Its own dependency tree pulls in a vulnerable `uuid` version:

- Missing buffer bounds check in uuid v3/v5/v6 — https://github.com/advisories/GHSA-w5hq-g745-h8pq

`npm audit fix --force` "fixes" this only by downgrading `exceljs` to
3.4.0 (a major-version, breaking change) — not applied. This is exceljs's
own unresolved dependency as of its current latest release, not something
fixable from this project alone.

**Current risk assessment:** accepted. This dependency is only ever used
to WRITE report files this app generates itself — no untrusted input ever
reaches it.
