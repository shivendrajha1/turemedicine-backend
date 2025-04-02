// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');

// Define secrets from environment variables with defaults
const PATIENT_ACCESS_TOKEN_SECRET = process.env.PATIENT_ACCESS_TOKEN_SECRET || 'patient_access_secret';
const DOCTOR_ACCESS_TOKEN_SECRET = process.env.DOCTOR_ACCESS_TOKEN_SECRET || 'doctor_access_secret';
const ADMIN_ACCESS_TOKEN_SECRET = process.env.ADMIN_ACCESS_TOKEN_SECRET || 'admin_access_secret'; // Added for admin

// General auth middleware (tries patient, doctor, or admin tokens)
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    let decoded;
    let user;

    // Try patient secret
    try {
      decoded = jwt.verify(token, PATIENT_ACCESS_TOKEN_SECRET);
      if (decoded.role !== 'patient') throw new Error('Invalid patient token role');
      user = await Patient.findById(decoded.id);
      if (!user) throw new Error('Patient not found');
      req.user = { id: user._id.toString(), role: 'patient' };
      console.log('Authenticated as patient:', req.user);
      return next();
    } catch (patientError) {
      // Log patient verification failure for debugging
      console.log('Patient token verification failed:', patientError.message);
    }

    // Try doctor secret
    try {
      decoded = jwt.verify(token, DOCTOR_ACCESS_TOKEN_SECRET);
      if (decoded.role !== 'doctor') throw new Error('Invalid doctor token role');
      user = await Doctor.findById(decoded.id);
      if (!user) throw new Error('Doctor not found');
      req.user = { id: user._id.toString(), role: 'doctor' };
      console.log('Authenticated as doctor:', req.user);
      return next();
    } catch (doctorError) {
      // Log doctor verification failure for debugging
      console.log('Doctor token verification failed:', doctorError.message);
    }

    // Try admin secret
    try {
      decoded = jwt.verify(token, ADMIN_ACCESS_TOKEN_SECRET);
      if (!['admin', 'superadmin'].includes(decoded.role)) throw new Error('Invalid admin token role');
      req.user = { id: decoded.id, role: decoded.role }; // Admin may not have a DB model yet
      console.log('Authenticated as admin:', req.user);
      return next();
    } catch (adminError) {
      // Log admin verification failure for debugging
      console.log('Admin token verification failed:', adminError.message);
    }

    // If all verifications fail, throw a generic error
    throw new Error('Invalid token');
  } catch (error) {
    console.error('auth error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Invalid token, please log in again',
    });
  }
};

// Patient-specific auth middleware
const authPatient = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication token required' });
    }

    const decoded = jwt.verify(token, PATIENT_ACCESS_TOKEN_SECRET);
    if (decoded.role !== 'patient') {
      return res.status(403).json({ error: 'Unauthorized: Not a patient' });
    }

    const patient = await Patient.findById(decoded.id);
    if (!patient) {
      return res.status(401).json({ error: 'Unauthorized: Patient not found' });
    }

    req.user = { id: patient._id.toString(), role: 'patient' };
    console.log('authPatient success:', req.user);
    next();
  } catch (error) {
    console.error('authPatient error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Invalid token',
    });
  }
};

// Doctor-specific auth middleware
const authDoctor = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication token required' });
    }

    const decoded = jwt.verify(token, DOCTOR_ACCESS_TOKEN_SECRET);
    if (decoded.role !== 'doctor') {
      return res.status(403).json({ error: 'Unauthorized: Not a doctor' });
    }

    const doctor = await Doctor.findById(decoded.id);
    if (!doctor) {
      return res.status(401).json({ error: 'Unauthorized: Doctor not found' });
    }

    req.user = { id: doctor._id.toString(), role: 'doctor' };
    console.log('authDoctor success:', req.user);
    next();
  } catch (error) {
    console.error('authDoctor error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Invalid token',
    });
  }
};

// Notification-specific auth for doctors
const authNotificationDoctor = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const decoded = jwt.verify(token, DOCTOR_ACCESS_TOKEN_SECRET);
    if (decoded.role !== 'doctor') {
      return res.status(403).json({ error: 'Unauthorized: Not a doctor' });
    }

    const doctor = await Doctor.findById(decoded.id);
    if (!doctor) {
      return res.status(401).json({ error: 'Unauthorized: Doctor not found' });
    }

    req.user = { id: doctor._id.toString(), role: 'doctor' };
    console.log('authNotificationDoctor success:', req.user);
    next();
  } catch (error) {
    console.error('authNotificationDoctor error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Please log in as a doctor',
    });
  }
};

// Notification-specific auth for patients
const authNotificationPatient = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized: No token provided' });
    }

    const decoded = jwt.verify(token, PATIENT_ACCESS_TOKEN_SECRET);
    if (decoded.role !== 'patient') {
      return res.status(403).json({ error: 'Unauthorized: Not a patient' });
    }

    const patient = await Patient.findById(decoded.id);
    if (!patient) {
      return res.status(401).json({ error: 'Unauthorized: Patient not found' });
    }

    req.user = { id: patient._id.toString(), role: 'patient' };
    console.log('authNotificationPatient success:', req.user);
    next();
  } catch (error) {
    console.error('authNotificationPatient error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Please log in as a patient',
    });
  }
};

// Admin-specific auth middleware
const authAdmin = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }

    const decoded = jwt.verify(token, ADMIN_ACCESS_TOKEN_SECRET);
    if (!['admin', 'superadmin'].includes(decoded.role)) {
      return res.status(403).json({ error: 'Access denied: Admin role required' });
    }

    // Note: If you have an Admin model, add a DB check here similar to Patient/Doctor
    req.user = { id: decoded.id, role: decoded.role };
    console.log('authAdmin success:', req.user);
    next();
  } catch (error) {
    console.error('authAdmin error:', error.message);
    res.status(401).json({
      error: error.name === 'TokenExpiredError'
        ? 'Unauthorized: Token expired'
        : 'Unauthorized: Invalid token',
    });
  }
};

module.exports = {
  auth,
  authPatient,
  authDoctor,
  authNotificationDoctor,
  authNotificationPatient,
  authAdmin,
};