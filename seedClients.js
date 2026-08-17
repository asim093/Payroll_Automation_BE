require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const Client = require('./models/Client');

const sampleClients = [
  {
    name: 'Test Client One',
    matchingRules: {
      emailAddresses: ['sender1@example.com'],
      domains: ['example.com'],
      notificationSenderPattern: 'logiforms.com',
    },
    outlookFolderPath: 'Test/ClientOne',
    status: 'active',
  },
  {
    name: 'Test Client Two',
    matchingRules: {
      emailAddresses: ['sender2@testcorp.com'],
      domains: ['testcorp.com'],
    },
    outlookFolderPath: 'Test/ClientTwo',
    status: 'active',
  },
];

const seedClients = async () => {
  try {
    await connectDB();

    await Client.deleteMany({});
    console.log('Existing clients cleared.');

    const created = await Client.insertMany(sampleClients);
    console.log(`${created.length} sample clients inserted:`);
    created.forEach((client) => console.log(`  - ${client.name} (${client._id})`));
  } catch (error) {
    console.error('Error seeding clients:', error.message);
  } finally {
    await mongoose.connection.close();
    console.log('Connection closed.');
  }
};

seedClients();
