const express = require('express');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const Doctor = require('../models/Doctor');
const { authPatient } = require('../middlewares/authMiddleware');
const { body, validationResult } = require('express-validator');
const router = express.Router();

// Middleware to check account status
const checkAccountStatus = async (req, res, next) => {
  try {
    const patient = await Patient.findById(req.user.id).select('accountStatus');
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    if (patient.accountStatus === 'deactivated') {
      return res.status(403).json({ error: 'Your account has been deactivated. Please contact support at support@truemedicine.com.' });
    }
    if (patient.accountStatus === 'banned') {
      return res.status(403).json({ error: 'Your account has been banned. Please contact support at support@truemedicine.com.' });
    }
    next();
  } catch (error) {
    console.error('Error checking account status:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
};

// Patient Dashboard Route
router.get('/patient-dashboard/:id', authPatient, checkAccountStatus, async (req, res) => {
  try {
    const requestedId = req.params.id;
    const authenticatedUserId = req.user.id;

    // Validate that the requested ID matches the authenticated user's ID
    if (requestedId !== authenticatedUserId || requestedId === 'undefined') {
      return res.status(403).json({ error: 'Unauthorized: You can only access your own dashboard' });
    }

    const patient = await Patient.findById(authenticatedUserId).select('-password');
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    // Fetch additional data for the dashboard
    const [appointments, notifications] = await Promise.all([
      Appointment.find({ patientId: authenticatedUserId }),
      Notification.find({ recipient: authenticatedUserId, recipientModel: 'Patient' }),
    ]);

    res.json({
      id: patient._id,
      name: patient.name,
      email: patient.email,
      phone: patient.phone,
      address: patient.address,
      gender: patient.gender,
      dateOfBirth: patient.dateOfBirth,
      accountStatus: patient.accountStatus, // Include accountStatus in response
      appointments,
      notifications,
    });
  } catch (error) {
    console.error('Error in patient dashboard:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get patient profile
router.get('/profile', authPatient, checkAccountStatus, async (req, res) => {
  try {
    const patient = await Patient.findById(req.user.id).select('-password');
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    res.json(patient);
  } catch (error) {
    console.error('Error fetching patient profile:', error.stack);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Update patient profile
router.put('/profile', authPatient, checkAccountStatus, [
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
    console.error('Error updating patient profile:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Get patient appointments
router.get('/appointments', authPatient, checkAccountStatus, async (req, res) => {
  try {
    const appointments = await Appointment.find({ patientId: req.user.id });
    res.status(200).json(appointments);
  } catch (error) {
    console.error('Error fetching appointments:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Get patient notifications
router.get('/notifications', authPatient, checkAccountStatus, async (req, res) => {
  try {
    const notifications = await Notification.find({ recipient: req.user.id, recipientModel: 'Patient' });
    res.status(200).json(notifications);
  } catch (error) {
    console.error('Error fetching notifications:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Get doctors by state and city (no auth required, so no account status check)
router.get('/doctors', async (req, res) => {
  try {
    const { state, city } = req.query;
    if (!state || !city) return res.status(400).json({ error: 'State and city are required' });
    const doctors = await Doctor.find({ state, city }).select('name specialization experience address');
    res.status(200).json(doctors);
  } catch (error) {
    console.error('Error fetching doctors:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

// Patient Change Password
router.post('/patient/change-password', authPatient, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const patient = await Patient.findById(req.user.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const isMatch = await patient.matchPassword(currentPassword);
    if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect' });

    patient.password = newPassword; // pre-save hook will hash it
    await patient.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error in patient change password:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});


module.exports = router;