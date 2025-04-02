// backend/routes/patient.js
const express = require('express');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const Doctor = require('../models/Doctor');
const { authPatient, auth } = require('../middlewares/authMiddleware'); // Line 6
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Get patient profile
router.get('/profile', authPatient, async (req, res) => {
  try {
    const patient = await Patient.findById(req.user.id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    res.json(patient);
  } catch (error) {
    console.error('Error fetching patient profile:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

router.put('/profile', authPatient, [
  body('name').optional().isString(),
  body('email').optional().isEmail(),
  body('phone').optional().isString(),
  body('address').optional().isString(),
  body('gender').optional().isString(),
  body('dateOfBirth').optional().isISO8601(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

  try {
    const { name, email, phone, address, gender, dateOfBirth } = req.body;
    const patient = await Patient.findById(req.user.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    patient.name = name || patient.name;
    patient.email = email || patient.email;
    patient.phone = phone || patient.phone;
    patient.address = address || patient.address;
    patient.gender = gender || patient.gender;
    patient.dateOfBirth = dateOfBirth || patient.dateOfBirth;

    await patient.save();
    res.status(200).json(patient);
  } catch (error) {
    console.error('Error updating patient profile:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/appointments', authPatient, async (req, res) => {
  try {
    const appointments = await Appointment.find({ patientId: req.user.id });
    res.status(200).json(appointments);
  } catch (error) {
    console.error('Error fetching appointments:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/notifications', authPatient, async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user.id, recipientModel: "Patient" });
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error);
    res.status(500).json({ error: error.message });
  }
});

router.get('/doctors', async (req, res) => {
  try {
    const { state, city } = req.query;
    if (!state || !city) return res.status(400).json({ error: 'State and city are required' });
    const doctors = await Doctor.find({ state, city }).select('name specialization experience address');
    res.status(200).json(doctors);
  } catch (error) {
    console.error('Error fetching doctors:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;