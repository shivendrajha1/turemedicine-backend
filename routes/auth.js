// routes/authRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const multer = require('multer');
const path = require('path');

// Configure Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, 'uploads/');
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  },
});
const upload = multer({ storage });

// Secrets
const PATIENT_ACCESS_TOKEN_SECRET = process.env.PATIENT_ACCESS_TOKEN_SECRET || 'patient_access_secret';
const DOCTOR_ACCESS_TOKEN_SECRET = process.env.DOCTOR_ACCESS_TOKEN_SECRET || 'doctor_access_secret';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your_refresh_token_secret';

// Patient Signup
router.post('/patient/signup', async (req, res) => {
  try {
    const { name, email, password, age, gender } = req.body;
    if (!name || !email || !password || !age || !gender) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingPatient = await Patient.findOne({ email });
    if (existingPatient) {
      return res.status(400).json({ error: 'Patient with this email already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newPatient = new Patient({ name, email, password: hashedPassword, age, gender });
    await newPatient.save();

    res.status(201).json({ message: 'Patient registered successfully' });
  } catch (error) {
    console.error('Error in patient signup:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Doctor Registration
router.post(
  '/doctor/register',
  upload.fields([
    { name: 'medicalLicense', maxCount: 1 },
    { name: 'degreeCertificate', maxCount: 1 },
    { name: 'idProof', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const {
        name, email, phone, specialization, state, city, experience, address, password,
      } = req.body;
      const emailLower = email.toLowerCase();

      console.log('Received registration data:', { email: emailLower, password });

      if (!name || !email || !phone || !specialization || !state || !city || !experience || !address || !password) {
        return res.status(400).json({ error: 'All fields are required' });
      }

      if (!req.files.medicalLicense || !req.files.degreeCertificate || !req.files.idProof) {
        return res.status(400).json({ error: 'All documents are required' });
      }

      const existingDoctor = await Doctor.findOne({ email: emailLower });
      if (existingDoctor) {
        console.log('Duplicate doctor found:', emailLower);
        return res.status(400).json({ error: 'Doctor with this email already exists' });
      }

      const doctor = new Doctor({
        name,
        email: emailLower,
        phone,
        specialization,
        state,
        city,
        experience: parseInt(experience),
        address,
        password, // Plaintext password; pre-save hook will hash it
        documents: {
          medicalLicense: req.files.medicalLicense[0].path.replace(/\\/g, '/'),
          degreeCertificate: req.files.degreeCertificate[0].path.replace(/\\/g, '/'),
          idProof: req.files.idProof[0].path.replace(/\\/g, '/'),
        },
        isVerified: false,
      });

      console.log('Saving doctor with plaintext password:', { email: emailLower, password });
      await doctor.save();
      const savedDoctor = await Doctor.findOne({ email: emailLower });
      console.log('Doctor saved with hashed password:', savedDoctor.password);

      const accessToken = jwt.sign(
        { id: doctor._id, role: 'doctor' },
        DOCTOR_ACCESS_TOKEN_SECRET,
        { expiresIn: '15m' }
      );
      const refreshToken = jwt.sign(
        { id: doctor._id, role: 'doctor' },
        REFRESH_TOKEN_SECRET,
        { expiresIn: '7d' }
      );

      await Doctor.updateOne({ _id: doctor._id }, { $set: { refreshToken } });
      console.log('Refresh token updated:', refreshToken);

      res.status(201).json({
        accessToken,
        refreshToken,
        doctorId: doctor._id,
        role: 'doctor',
      });
    } catch (error) {
      console.error('Error in doctor registration:', error.stack);
      res.status(500).json({ error: 'Server error', details: error.message });
    }
  }
);

// Patient Login
router.post('/patient/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

    const patient = await Patient.findOne({ email });
    if (!patient || !await bcrypt.compare(password, patient.password)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = jwt.sign({ id: patient._id, role: 'patient' }, PATIENT_ACCESS_TOKEN_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: patient._id, role: 'patient' }, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Login successful',
      patientId: patient._id,
      role: 'patient',
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error in patient login:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Doctor Login
router.post('/doctor/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const emailLower = email.toLowerCase();
    console.log('Doctor login attempt:', { email: emailLower, password });

    if (!email || !password) {
      console.log('Missing email or password');
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const doctor = await Doctor.findOne({ email: emailLower });
    if (!doctor) {
      console.log('Doctor not found:', emailLower);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await doctor.matchPassword(password);
    console.log('Password match result:', isMatch);

    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = jwt.sign({ id: doctor._id, role: 'doctor' }, DOCTOR_ACCESS_TOKEN_SECRET, { expiresIn: '15m' });
    const refreshToken = jwt.sign({ id: doctor._id, role: 'doctor' }, REFRESH_TOKEN_SECRET, { expiresIn: '7d' });

    await Doctor.updateOne({ _id: doctor._id }, { $set: { refreshToken } });
    console.log('Refresh token updated:', refreshToken);

    res.json({
      message: 'Login successful',
      doctorId: doctor._id,
      role: 'doctor',
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error in doctor login:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Refresh Token
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) {
    return res.status(401).json({ error: 'Refresh token not found' });
  }

  try {
    let decoded;
    try {
      decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    const user = decoded.role === 'patient' 
      ? await Patient.findById(decoded.id) 
      : await Doctor.findById(decoded.id);

    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const accessTokenSecret = decoded.role === 'patient' 
      ? PATIENT_ACCESS_TOKEN_SECRET 
      : DOCTOR_ACCESS_TOKEN_SECRET;

    const accessToken = jwt.sign(
      { id: user._id, role: decoded.role },
      accessTokenSecret,
      { expiresIn: '15m' }
    );

    res.json({
      message: 'Token refreshed successfully',
      accessToken,
      role: decoded.role,
    });
  } catch (error) {
    console.error('Error refreshing token:', error.stack);
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

// Logout
router.post('/logout', (req, res) => {
  res.json({ message: 'Logged out successfully' });
});

module.exports = router;