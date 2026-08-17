const Client = require('../models/Client');

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
