const crypto = require('crypto');
const User = require('../models/User');

const generateDummyToken = () => crypto.randomBytes(24).toString('hex');

const upsertAndRespond = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !String(email).trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      { email: normalizedEmail, lastLoginAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    );

    res.status(200).json({ token: generateDummyToken(), user: { email: user.email } });
  } catch (error) {
    next(error);
  }
};


exports.signup = upsertAndRespond;

exports.login = upsertAndRespond;
