require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./config/db');
const ReviewQueue = require('./models/ReviewQueue');

const run = async () => {
  await connectDB();
  const entry = await ReviewQueue.findById('6a8f15c243bac44271046fe4');
  console.log(JSON.stringify(entry, null, 2));
  await mongoose.connection.close();
};
run();
