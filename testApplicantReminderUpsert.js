require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');
const ApplicantReminder = require('./models/ApplicantReminder');
const { upsertFromComplianceRun, listReminders, hashSsn, normalizeSsn } = require('./services/applicantReminderService');

let PASS = 0;
let FAIL = 0;
const check = (label, pass, detail) => {
  if (pass) {
    PASS += 1;
    console.log(`  PASS  ${label}`);
  } else {
    FAIL += 1;
    console.log(`  FAIL  ${label}${detail ? `  -> ${detail}` : ''}`);
  }
};

const rec = (ssn, name, email, isComplete, status, startISO) => ({
  ssn,
  employeeName: name,
  email,
  isComplete,
  status,
  startDate: new Date(`${startISO}T00:00:00Z`),
  weekEndingDate: new Date(`${startISO}T00:00:00Z`),
});

const run = async () => {
  await connectDB();
  const client = await Client.create({
    name: 'ZZ Reminder Test Client',
    status: 'active',
    fein: '999999999',
    wotcFormUrl: 'https://forms.example.com/zz',
  });
  const cid = client._id;
  const byHash = async (ssn) =>
    ApplicantReminder.findOne({ clientId: cid, employeeSsnHash: hashSsn(normalizeSsn(ssn)) }).lean();

  try {
    console.log('=== RUN 1: A(no_logiforms), B(unrecognized), C(incomplete no-email), D(complete) ===');
    const r1 = await upsertFromComplianceRun(cid, new Date('2026-09-01T10:00:00Z'), [
      rec('900-00-0001', 'Emp A', 'a@zz-test.local', false, 'Incomplete', '2026-08-06'),
      rec('900-00-0002', 'Emp B', 'b@zz-test.local', false, 'SomeWeirdStatus', '2026-08-06'),
      rec('900-00-0003', 'Emp C', '', false, 'Incomplete', '2026-08-06'),
      rec('900-00-0004', 'Emp D', 'd@zz-test.local', true, 'Certified', '2026-08-06'),
    ]);
    check('created 3', r1.created === 3, `got ${r1.created}`);
    check('superseded 0', r1.superseded === 0);
    const a1 = await byHash('900-00-0001');
    const b1 = await byHash('900-00-0002');
    const c1 = await byHash('900-00-0003');
    check('A pending + kind no_logiforms_record', a1.reminderStatus === 'pending' && a1.incompleteKind === 'no_logiforms_record');
    check(
      'B pending + kind unrecognized_status + status preserved',
      b1.reminderStatus === 'pending' && b1.incompleteKind === 'unrecognized_status' && b1.logiformsStatusAtRun === 'SomeWeirdStatus'
    );
    check('C pending + empty email + last4', c1.reminderStatus === 'pending' && c1.employeeEmail === '' && c1.employeeSsnLast4 === '0003');
    check('D not persisted (complete)', (await byHash('900-00-0004')) === null);

    console.log('\n=== RUN 2: A now complete, B/C still incomplete, E new incomplete ===');
    const r2 = await upsertFromComplianceRun(cid, new Date('2026-09-08T10:00:00Z'), [
      rec('900-00-0001', 'Emp A', 'a@zz-test.local', true, 'Certified', '2026-08-06'),
      rec('900-00-0002', 'Emp B', 'b2@zz-test.local', false, 'SomeWeirdStatus', '2026-08-06'),
      rec('900-00-0003', 'Emp C', 'c-now@zz-test.local', false, 'Incomplete', '2026-08-06'),
      rec('900-00-0005', 'Emp E', 'e@zz-test.local', false, 'Incomplete', '2026-08-13'),
    ]);
    check('A superseded', (await byHash('900-00-0001')).reminderStatus === 'superseded');
    check(
      'B refreshed (pending, new email)',
      (await byHash('900-00-0002')).reminderStatus === 'pending' && (await byHash('900-00-0002')).employeeEmail === 'b2@zz-test.local'
    );
    check('C refreshed email empty -> filled', (await byHash('900-00-0003')).employeeEmail === 'c-now@zz-test.local');
    check('E created', (await byHash('900-00-0005')).reminderStatus === 'pending');
    check('r2.superseded === 1', r2.superseded === 1, `got ${r2.superseded}`);
    check('r2.refreshed === 2', r2.refreshed === 2, `got ${r2.refreshed}`);
    check('r2.created === 1', r2.created === 1, `got ${r2.created}`);

    console.log('\n=== RUN 3: B marked draft_created, still incomplete -> held ===');
    await ApplicantReminder.updateOne(
      { clientId: cid, employeeSsnHash: hashSsn(normalizeSsn('900-00-0002')) },
      { reminderStatus: 'draft_created', reminderActionedAt: new Date('2026-09-08T12:00:00Z') }
    );
    const r3 = await upsertFromComplianceRun(cid, new Date('2026-09-15T10:00:00Z'), [
      rec('900-00-0002', 'Emp B', 'b3@zz-test.local', false, 'AnotherStatus', '2026-08-06'),
      rec('900-00-0003', 'Emp C', 'c-now@zz-test.local', false, 'Incomplete', '2026-08-06'),
      rec('900-00-0005', 'Emp E', 'e@zz-test.local', false, 'Incomplete', '2026-08-13'),
    ]);
    const b3 = await byHash('900-00-0002');
    check('B still draft_created (held)', b3.reminderStatus === 'draft_created', `got ${b3.reminderStatus}`);
    check('B email NOT overwritten (guard keeps it)', b3.employeeEmail === 'b2@zz-test.local', `got ${b3.employeeEmail}`);
    check('B logiformsStatusAtRun refreshed', b3.logiformsStatusAtRun === 'AnotherStatus', `got ${b3.logiformsStatusAtRun}`);
    check('B complianceRunAt refreshed', new Date(b3.complianceRunAt).toISOString() === '2026-09-15T10:00:00.000Z');
    check('r3.held === 1', r3.held === 1, `got ${r3.held}`);

    console.log('\n=== RUN 4: C marked draft_created, C now complete -> stays draft_created ===');
    await ApplicantReminder.updateOne({ clientId: cid, employeeSsnHash: hashSsn(normalizeSsn('900-00-0003')) }, { reminderStatus: 'draft_created' });
    await upsertFromComplianceRun(cid, new Date('2026-09-22T10:00:00Z'), [
      rec('900-00-0003', 'Emp C', 'c-now@zz-test.local', true, 'Certified', '2026-08-06'),
      rec('900-00-0005', 'Emp E', 'e@zz-test.local', false, 'Incomplete', '2026-08-13'),
    ]);
    check('C still draft_created (not superseded)', (await byHash('900-00-0003')).reminderStatus === 'draft_created');
    check('E still pending', (await byHash('900-00-0005')).reminderStatus === 'pending');

    console.log('\n=== listReminders ===');
    const listed = await listReminders({ clientId: String(cid) });
    check('listReminders returns 4 rows (A superseded, B+C draft_created, E pending)', listed.length === 4, `got ${listed.length}`);
    check('listReminders sorted desc by complianceRunAt', listed[0].complianceRunAt >= listed[listed.length - 1].complianceRunAt);
    check(
      'listReminders populates client name + wotcFormUrl',
      listed[0].clientId.name === 'ZZ Reminder Test Client' && listed[0].clientId.wotcFormUrl === 'https://forms.example.com/zz'
    );
    const pendingOnly = await listReminders({ clientId: String(cid), status: 'pending' });
    check('status filter works', pendingOnly.every((r) => r.reminderStatus === 'pending'));

    console.log(`\n${FAIL ? 'SOME CHECKS FAILED' : 'ALL CHECKS PASSED'} (${PASS} passed, ${FAIL} failed)`);
  } finally {
    const deleted = await ApplicantReminder.deleteMany({ clientId: cid });
    await Client.deleteOne({ _id: cid });
    console.log(`cleanup: ${deleted.deletedCount} ApplicantReminder rows + test client removed`);
    await mongoose.disconnect();
  }
  process.exit(FAIL ? 1 : 0);
};

run().catch((error) => {
  console.error('TEST SCRIPT ERROR:', error);
  process.exit(1);
});
