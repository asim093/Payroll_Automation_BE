require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const { processEmail } = require('./services/emailProcessor');
const EmailLog = require('./models/EmailLog');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  try {
    await connectDB();

    console.log('=== TEST C: unmatched sender, NO attachments, body mentions "attached" (safety-net case) ===');
    const messageIdC = `test-safety-net-mentions-attach-${Date.now()}`;
    const emailDataC = {
      messageId: messageIdC,
      sender: 'admin@some-unmatched-agency-test.invalid',
      subject: 'Some Employee WOTC EE Name- Test Person / TP-0001',
      bodyPreview: 'Hi,\n\nPlease find the attached WOTC Form for Test Employer employee - Test Person / TP-0001\n\nThank you,\nTest Employer.',
      receivedDateTime: new Date(),
      attachments: [],
    };

    const resultC = await processEmail(emailDataC);
    console.log(`EmailLog status: ${resultC.status}`);
    const reviewQueueEntryC = await ReviewQueue.findOne({ referenceId: resultC._id });
    console.log(`ReviewQueue entry created? ${reviewQueueEntryC ? `YES, reason: ${reviewQueueEntryC.reason}` : 'No'}`);
    console.log(`Expected: ReviewQueue YES with reason "possible_missed_attachment" -> ${reviewQueueEntryC && reviewQueueEntryC.reason === 'possible_missed_attachment' ? 'PASS' : 'FAIL'}`);

    console.log('\n=== TEST D: unmatched sender, NO attachments, NO mention of attachment (should still skip) ===');
    const messageIdD = `test-safety-net-no-mention-${Date.now()}`;
    const emailDataD = {
      messageId: messageIdD,
      sender: 'no-reply@some-verification-service-test.invalid',
      subject: 'Your verification code is 123456',
      bodyPreview: 'Your one-time verification code is 123456. This code expires in 10 minutes.',
      receivedDateTime: new Date(),
      attachments: [],
    };

    const resultD = await processEmail(emailDataD);
    console.log(`EmailLog status: ${resultD.status}`);
    const reviewQueueEntryD = await ReviewQueue.findOne({ referenceId: resultD._id });
    console.log(`ReviewQueue entry created? ${reviewQueueEntryD ? 'YES (unexpected)' : 'No'}`);
    console.log(`Expected: no_attachment_skipped, no ReviewQueue -> ${resultD.status === 'no_attachment_skipped' && !reviewQueueEntryD ? 'PASS' : 'FAIL'}`);

    console.log('\nCleaning up test records...');
    await EmailLog.deleteOne({ _id: resultC._id });
    if (reviewQueueEntryC) await ReviewQueue.deleteOne({ _id: reviewQueueEntryC._id });
    await EmailLog.deleteOne({ _id: resultD._id });
    if (reviewQueueEntryD) await ReviewQueue.deleteOne({ _id: reviewQueueEntryD._id });
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
