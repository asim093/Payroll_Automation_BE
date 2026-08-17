const Client = require('../models/Client');
const EmailLog = require('../models/EmailLog');
const FileLog = require('../models/FileLog');

// @desc    Create a new client
// @route   POST /api/clients
exports.createClient = async (req, res, next) => {
  try {
    const { name, matchingRules } = req.body;

    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'name is required' });
    }

    const emailAddresses = matchingRules?.emailAddresses || [];
    const domains = matchingRules?.domains || [];
    if (emailAddresses.length === 0 && domains.length === 0) {
      return res.status(400).json({
        error: 'At least one matchingRules.emailAddresses or matchingRules.domains entry is required',
      });
    }

    const client = await Client.create(req.body);
    res.status(201).json(client);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all clients
// @route   GET /api/clients
exports.getAllClients = async (req, res, next) => {
  try {
    const clients = await Client.find();
    res.status(200).json(clients);
  } catch (error) {
    next(error);
  }
};

// @desc    Get all clients, each with a `lastActivity` date — the most
//          recent of either its last matched EmailLog (receivedAt) or its
//          last FileLog (processedAt). One aggregation query per collection
//          (grouped by client), not one query per client, so this stays
//          fast regardless of client count.
// @route   GET /api/clients/with-last-activity
exports.getClientsWithLastActivity = async (req, res, next) => {
  try {
    const clients = await Client.find().sort({ name: 1 }).lean();

    const [emailActivity, fileActivity] = await Promise.all([
      EmailLog.aggregate([
        { $match: { matchedClientId: { $ne: null } } },
        { $group: { _id: '$matchedClientId', lastAt: { $max: '$receivedAt' } } },
      ]),
      FileLog.aggregate([
        { $match: { clientId: { $ne: null } } },
        { $group: { _id: '$clientId', lastAt: { $max: '$processedAt' } } },
      ]),
    ]);

    const emailMap = new Map(emailActivity.map((row) => [String(row._id), row.lastAt]));
    const fileMap = new Map(fileActivity.map((row) => [String(row._id), row.lastAt]));

    const enriched = clients.map((client) => {
      const emailDate = emailMap.get(String(client._id));
      const fileDate = fileMap.get(String(client._id));

      let lastActivity = null;
      if (emailDate && fileDate) {
        lastActivity = new Date(emailDate) > new Date(fileDate) ? emailDate : fileDate;
      } else {
        lastActivity = emailDate || fileDate || null;
      }

      return { ...client, lastActivity };
    });

    res.status(200).json(enriched);
  } catch (error) {
    next(error);
  }
};

// @desc    Recent activity for a single client — its 5 most-recent
//          emails/files combined (not 5 of each), newest first. Used by the
//          Clients page's per-row expand/modal.
// @route   GET /api/clients/:id/history
exports.getClientHistory = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    const [emails, files] = await Promise.all([
      EmailLog.find({ matchedClientId: client._id }).sort({ receivedAt: -1 }).limit(5).lean(),
      FileLog.find({ clientId: client._id }).sort({ processedAt: -1 }).limit(5).lean(),
    ]);

    const history = [
      ...emails.map((email) => ({
        type: 'email',
        date: email.receivedAt,
        sender: email.sender,
        subject: email.subject,
        status: email.status,
      })),
      ...files.map((file) => ({
        type: 'file',
        date: file.processedAt,
        originalName: file.originalName,
        destination: file.destination,
        status: file.status,
      })),
    ]
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 5);

    res.status(200).json({ client, history });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single client by id
// @route   GET /api/clients/:id
exports.getClientById = async (req, res, next) => {
  try {
    const client = await Client.findById(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
};

// @desc    Update a client
// @route   PUT /api/clients/:id
exports.updateClient = async (req, res, next) => {
  try {
    const client = await Client.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.status(200).json(client);
  } catch (error) {
    next(error);
  }
};

// @desc    Delete a client
// @route   DELETE /api/clients/:id
exports.deleteClient = async (req, res, next) => {
  try {
    const client = await Client.findByIdAndDelete(req.params.id);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }
    res.status(200).json({ message: 'Client deleted successfully' });
  } catch (error) {
    next(error);
  }
};
