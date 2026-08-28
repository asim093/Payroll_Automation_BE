require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { processEmail } = require('./services/emailProcessor');
const EmailLog = require('./models/EmailLog');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  try {
    await connectDB();

    console.log('=== TEST A: unmatched sender, NO attachments ===');
    const messageIdA = `test-attachment-gate-no-attach-${Date.now()}`;
    const emailDataA = {
      messageId: messageIdA,
      sender: 'no-reply@some-unmatched-service-test.invalid',
      subject: '[TEST] Verification code style email, no attachment',
      receivedDateTime: new Date(),
      attachments: [],
    };

    const resultA = await processEmail(emailDataA);
    console.log(`EmailLog status: ${resultA.status}`);
    const reviewQueueEntryA = await ReviewQueue.findOne({ referenceId: resultA._id });
    console.log(`ReviewQueue entry created? ${reviewQueueEntryA ? 'YES (BUG!)' : 'No (correct)'}`);

    console.log('\n=== TEST B: unmatched sender, WITH attachment ===');
    const messageIdB = `test-attachment-gate-with-attach-${Date.now()}`;
    const emailDataB = {
      messageId: messageIdB,
      sender: 'payroll@some-unmatched-client-test.invalid',
      subject: '[TEST] Genuine payroll email with attachment',
      receivedDateTime: new Date(),
      attachments: [{ name: 'dummy-payroll.xlsx', contentBase64: Buffer.from('dummy content').toString('base64') }],
    };

    const resultB = await processEmail(emailDataB);
    console.log(`EmailLog status: ${resultB.status}`);
    const reviewQueueEntryB = await ReviewQueue.findOne({ referenceId: resultB._id });
    console.log(`ReviewQueue entry created? ${reviewQueueEntryB ? 'YES (correct)' : 'No (BUG!)'}`);

    console.log('\nCleaning up test records...');
    await EmailLog.deleteOne({ _id: resultA._id });
    if (reviewQueueEntryA) await ReviewQueue.deleteOne({ _id: reviewQueueEntryA._id });
    await EmailLog.deleteOne({ _id: resultB._id });
    if (reviewQueueEntryB) await ReviewQueue.deleteOne({ _id: reviewQueueEntryB._id });
    console.log('Cleaned up.');
  } catch (error) {
    console.error('Error running test:', error.message);
    console.error(error.stack);
  } finally {
    await mongoose.connection.close();
    console.log('\nConnection closed.');
  }
};

run();
