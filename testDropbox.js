require('dotenv').config();
const { uploadFileToDropbox } = require('./services/dropboxService');

const run = async () => {
  try {
    const content = Buffer.from('This is a test file from automation');
    const uploadedPath = await uploadFileToDropbox(
      'Test Client One',
      'dropbox-test.csv',
      content
    );
    console.log('SUCCESS! File uploaded to Dropbox:');
    console.log(uploadedPath);
  } catch (error) {
    console.error('Dropbox upload failed. Full error detail:');
    console.error(error);
  }
};

run();
