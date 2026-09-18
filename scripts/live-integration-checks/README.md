# Live integration checks

The scripts in this folder are **not** a regression suite and must never be run automatically (no CI, no npm script, no scheduler hook).

Each one creates a **real draft in the actual connected Outlook mailbox** via Microsoft Graph (`Mail.ReadWrite`, never `/send`) to prove the live end-to-end path works, then deletes what it created before exiting. They exist to verify the real integration once when something about the Graph draft-creation path changes — not to be re-run casually, since every run touches a live external system.

- `testRealCustomerReportDraftCreation.js` — verifies `customerEmailDraftService.js`'s real Graph draft path (subject/body/attachment/from), using an existing `CustomerReportEmail` row for a `ZZZ Test Client` in the database.
- `testRealGraphDraftCreation.js` — verifies `reminderDraftService.js`'s real Graph draft path for an applicant reminder. Usage: `node scripts/live-integration-checks/testRealGraphDraftCreation.js <fake-recipient-email>` — the recipient is a required CLI argument on purpose; never hardcode a real address here.

Both temporarily patch a copy of their target service (flipping `COMPLIANCE_EMAIL_SEND_ENABLED` / `REMINDER_SEND_ENABLED` to `true` in a throwaway file written next to the real one, deleted in a `finally` block) so the real Graph call path runs once, without touching the actual source file or the running app's send-gate.

**Known stale reference:** both scripts' error messages point at `zzz11_setup.js`/`zzz11_run.js` (customer) and a `ZZZ Test Client 10` fixture (reminder) for the test data they expect to already exist. Those setup scripts were deleted in the dev-script cleanup — if you need to run either check again, recreate the equivalent test data (a `ZZZ Test Client` with a staged `CustomerReportEmail` row, or an `ApplicantReminder` row) manually first.

Only run these with explicit intent, and confirm the mailbox afterward if the script reports it couldn't delete what it created.
