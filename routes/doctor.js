const express = require('express');
const Doctor = require('../models/Doctor');
const router = express.Router();

// Fetch doctors by state and city
router.get('/api/doctors', async (req, res) => {
  try {
    const { state, city } = req.query;

    // Validate input
    if (!state || !city) {
      return res.status(400).json({ error: 'State and city are required.' });
    }

    // Fetch doctors from the database
    const doctors = await Doctor.find({ state, city }).select(
      'name specialization experience'
    );

    res.status(200).json(doctors);
  } catch (error) {
    console.error('Error fetching doctors:', error);
    res.status(500).json({ error: error.message });
  }
});

// Search doctors by specialty, state, city, or name
router.get('/doctors/search', async (req, res) => {
    try {
      const { specialty, state, city, name } = req.query;
  
      // Build the search query
      const query = {};
      if (specialty) query.specialization = { $regex: specialty, $options: 'i' };
      if (state) query.state = { $regex: state, $options: 'i' };
      if (city) query.city = { $regex: city, $options: 'i' };
      if (name) query.name = { $regex: name, $options: 'i' };
  
      // Fetch doctors from the database
      const doctors = await Doctor.find(query).select(
        'name specialization experience state city address'
      );
  
      res.status(200).json(doctors);
    } catch (error) {
      console.error('Error searching doctors:', error);
      res.status(500).json({ error: error.message });
    }
  });

module.exports = router;