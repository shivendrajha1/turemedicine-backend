const express = require('express');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const Razorpay = require('razorpay');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const Appointment = require('../models/Appointment');
const Feedback = require('../models/Feedback');
const Prescription = require('../models/Prescription');
const PlatformSettings = require('../models/PlatformSettings');
const Admin = require('../models/Admin');
const Withdrawal = require('../models/Withdrawal');
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const cron = require('node-cron');
const router = express.Router();
const B2 = require('backblaze-b2');
const axios = require('axios');

// Initialize Backblaze B2
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

let b2BucketId = null;
let b2ApiUrl = null;
let b2DownloadUrl = null;

const initializeB2 = async () => {
  try {
    const authResponse = await b2.authorize();
    if (!authResponse.data.apiUrl || !authResponse.data.downloadUrl) {
      throw new Error('Authorization response missing apiUrl or downloadUrl');
    }
    b2ApiUrl = authResponse.data.apiUrl;
    b2DownloadUrl = authResponse.data.downloadUrl;
    b2.apiUrl = b2ApiUrl; // Force the internal state
    const bucketResponse = await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME });
    if (!bucketResponse.data.buckets || bucketResponse.data.buckets.length === 0) {
      throw new Error(`Bucket "${process.env.B2_BUCKET_NAME}" not found`);
    }
    b2BucketId = bucketResponse.data.buckets[0].bucketId;
    console.log('B2 initialized successfully:', { b2ApiUrl, b2DownloadUrl, b2BucketId, internalApiUrl: b2.apiUrl });
  } catch (err) {
    console.error('B2 initialization error:', err.stack);
    throw err;
  }
};

// Initialize at startup
(async () => {
  try {
    await initializeB2();
    console.log('Backblaze B2 initialized successfully');
  } catch (err) {
    console.error('Critical error: Failed to initialize Backblaze B2 at startup:', err.message);
    process.exit(1); // Exit the process to prevent running with an uninitialized B2 client
  }
})();

const ADMIN_USERID = 'Shivendra1235';
const ADMIN_PASSWORD = '123456';
const JWT_SECRET = process.env.JWT_SECRET || 'default_jwt_secret';

const scheduledReports = new Map();

// Add refresh token secret
const REFRESH_JWT_SECRET = process.env.REFRESH_JWT_SECRET || 'default_refresh_secret';
// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});
console.log('Razorpay initialized with key:', process.env.RAZORPAY_KEY_ID ? 'Set' : 'Not set');

// Define the formatDate function in the backend
const formatDate = (date) => date.toISOString().split('T')[0];

// Create a reusable transporter object for sending emails
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
  tls: {
    rejectUnauthorized: false,
  },
});

transporter.verify((error, success) => {
  if (error) {
    console.error('SMTP configuration error:', error);
  } else {
    console.log('SMTP server is ready to send emails');
  }
});


// Ensure invoice directory exists
const invoiceDir = path.join(__dirname, '../invoices');
if (!fs.existsSync(invoiceDir)) {
  fs.mkdirSync(invoiceDir);
}

// Admin Authentication Middleware
// Admin Authentication Middleware (Updated to support multiple roles)
// Admin Authentication Middleware
const authAdmin = async (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    req.admin = { id: admin._id, role: admin.role }; // Role will be 'Super Admin', etc.
    next();
  } catch (error) {
    console.error('Token verification error:', error.message);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Super Admin Only Middleware
// Super Admin Only Middleware
const superAdminOnly = (req, res, next) => {
  if (req.admin.role !== 'Super Admin') { // Updated to match model
    return res.status(403).json({ error: 'Access denied: Super Admin only' });
  }
  next();
};

// Seed initial Super Admin (Run once or check on server start)
// Seed Super Admin (Updated to match model)
const seedSuperAdmin = async () => {
  try {
    const superAdminExists = await Admin.findOne({ email: 'Shivendra1235@example.com' });
    if (!superAdminExists) {
      const superAdmin = new Admin({
        name: 'Shivendra',
        email: 'Shivendra1235@example.com',
        password: 'Shivendra1235', // Will be hashed
        role: 'Super Admin', // Matches Admin model enum
      });
      await superAdmin.save();
      console.log('Super Admin seeded: Shivendra1235@example.com');
    } else {
      console.log('Super Admin already exists');
    }
  } catch (err) {
    console.error('Error seeding Super Admin:', err.message);
  }
};


// Get admin profile
router.get('/profile', authAdmin, async (req, res) => {
  try {
    const admin = await Admin.findById(req.admin.id).select('-password');
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    res.json({
      id: admin._id,
      name: admin.name || 'Admin User',
      role: admin.role || 'admin',
      email: admin.email,
    });
  } catch (err) {
    console.error('Admin profile fetch error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin Login (Updated to match model)
// Admin Login (Updated to issue refresh token)
// routes/admin.js
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const admin = await Admin.findOne({ email });
    if (!admin || !(await admin.matchPassword(password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const accessToken = jwt.sign({ id: admin._id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });
    const refreshToken = jwt.sign({ id: admin._id, role: admin.role }, REFRESH_JWT_SECRET, { expiresIn: '7d' });
    res.json({
      id: admin._id, // Add this
      role: admin.role,
      accessToken, // Rename 'token' to 'accessToken'
      refreshToken, // Include this
      name: admin.name, // Optional
    });
  } catch (err) {
    console.error('Admin login error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// Refresh Token Endpoint
router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'No refresh token provided' });

  try {
    const decoded = jwt.verify(refreshToken, REFRESH_JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin) return res.status(401).json({ error: 'Admin not found' });
    const newAccessToken = jwt.sign({ id: admin._id, role: admin.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ accessToken: newAccessToken, role: admin.role });
  } catch (err) {
    console.error('Refresh token error:', err.message);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Get All Admins/ Get all admins (Super Admin only)
router.get('/admins', authAdmin, async (req, res) => {
  if (req.admin.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const admins = await Admin.find().select('-password');
    res.json(admins);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Create admin (Super Admin only)
router.post('/admins', authAdmin, async (req, res) => {
  if (req.admin.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name, email, password, role } = req.body;
  try {
    const admin = new Admin({ name, email, password, role });
    await admin.save();
    res.status(201).json(admin);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update admin (Super Admin only)
router.put('/admins/:id', authAdmin, async (req, res) => {
  if (req.admin.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  const { name, email, password, role } = req.body;
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    admin.name = name || admin.name;
    admin.email = email || admin.email;
    if (password) admin.password = password; // Will be hashed by pre-save hook
    admin.role = role || admin.role;
    await admin.save();
    res.json(admin);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete admin (Super Admin only, prevent initial Super Admin deletion)
router.delete('/admins/:id', authAdmin, async (req, res) => {
  if (req.admin.role !== 'Super Admin') {
    return res.status(403).json({ error: 'Access denied' });
  }
  try {
    const admin = await Admin.findById(req.params.id);
    if (!admin) {
      return res.status(404).json({ error: 'Admin not found' });
    }
    if (admin.isInitialSuperAdmin) {
      return res.status(403).json({ error: 'Cannot delete the initial Super Admin' });
    }
    await admin.remove();
    res.json({ message: 'Admin removed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});


// Route to download doctor documents
// Update your download route with better path handling
router.get('/doctors/:doctorId/documents/:documentType', authAdmin, async (req, res) => {
  try {
    const { doctorId, documentType } = req.params;

    // Validate document type
    const validTypes = ['medicalLicense', 'degreeCertificate', 'idProof'];
    if (!validTypes.includes(documentType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }

    // Find doctor
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    // Get file path
    const filePath = doctor.documents?.[documentType];
    if (!filePath) {
      return res.status(404).json({ error: `${documentType} not found for this doctor` });
    }

    // Authorize with B2 if not already done
    if (!b2BucketId) {
      await b2.authorize();
      const bucketResponse = await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME });
      b2BucketId = bucketResponse.data.buckets[0].bucketId;
    }

    // Get download authorization
    const { data: auth } = await b2.getDownloadAuthorization({
      bucketId: b2BucketId,
      fileNamePrefix: filePath.replace(`${process.env.B2_BUCKET_NAME}/`, ''),
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    // Construct the direct download URL
    const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${filePath.replace(`${process.env.B2_BUCKET_NAME}/`, '')}?Authorization=${auth.authorizationToken}`;

    // Return the URL instead of streaming the file
    res.json({ url: downloadUrl });
  } catch (err) {
    console.error('Document fetch error:', {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      error: 'Failed to fetch document URL',
      details: err.message,
    });
  }
});

// Users Management
// Users Management with State and City Filters
/// Users Management with State and City Filters and Detailed Earnings
// Users Management with State and City Filters and Detailed Earnings
router.get('/users', authAdmin, async (req, res) => {
  try {
    const { state, city } = req.query;

    const userFilter = {};
    if (state) userFilter.state = state;
    if (city) userFilter.city = city;

    const patients = await Patient.find(userFilter).select('-password');
    const doctors = await Doctor.find(userFilter).select('-password');
    const doctorIds = doctors.map(doc => doc._id);

    // Total appointments per doctor
    const appointments = await Appointment.aggregate([
      { $match: { doctorId: { $in: doctorIds } } },
      { $group: { _id: '$doctorId', count: { $sum: 1 } } },
    ]);

    // Completed appointments with gross earnings
    const completedAppointments = await Appointment.find({
      doctorId: { $in: doctorIds },
      status: 'completed',
    });

    // Fetch withdrawals for pending payout calculation
    const withdrawals = await Withdrawal.find({
      doctorId: { $in: doctorIds },
      status: 'approved'
    });

    const doctorStats = await Promise.all(doctors.map(async (doc) => {
      const appStats = appointments.find(a => a._id.toString() === doc._id.toString()) || { count: 0 };

      // Filter completed appointments for this doctor
      const doctorCompletedApps = completedAppointments.filter(
        app => app.doctorId.toString() === doc._id.toString()
      );

      const grossEarnings = doctorCompletedApps.reduce((sum, app) => sum + (app.consultationFee || 0), 0);
      
      // Calculate final earnings (after commission)
      const finalEarnings = doctorCompletedApps.reduce((sum, app) => {
        const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
        return sum + (app.consultationFee || 0) - doctorCommission;
      }, 0);

      // Calculate total withdrawn amount for this doctor
      const totalWithdrawn = withdrawals
        .filter(w => w.doctorId.toString() === doc._id.toString())
        .reduce((sum, w) => sum + (w.approvedAmount || w.amount || 0), 0);

      // Calculate pending payout
      const pendingPayout = finalEarnings - totalWithdrawn;

      return {
        ...doc.toObject(),
        appointmentCount: appStats.count,
        completedAppointmentCount: doctorCompletedApps.length,
        totalEarnings: grossEarnings || 0,  // Gross earnings before commission
        finalEarnings: finalEarnings || 0,  // Earnings after commission
        pendingPayout: pendingPayout > 0 ? pendingPayout : 0,  // Pending payout amount
      };
    }));

    res.json({ patients, doctors: doctorStats });
  } catch (err) {
    console.error('Users fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Unique States
router.get('/states', authAdmin, async (req, res) => {
  try {
    const doctorStates = await Doctor.distinct('state');
    const patientStates = await Patient.distinct('state');
    const states = [...new Set([...doctorStates, ...patientStates])].sort();
    res.json(states);
  } catch (err) {
    console.error('States fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Unique Cities for a Given State
router.get('/cities', authAdmin, async (req, res) => {
  try {
    const { state } = req.query;
    if (!state) return res.status(400).json({ error: 'State parameter is required' });

    const doctorCities = await Doctor.distinct('city', { state });
    const patientCities = await Patient.distinct('city', { state });
    const cities = [...new Set([...doctorCities, ...patientCities])].sort();
    res.json(cities);
  } catch (err) {
    console.error('Cities fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});


router.get('/users/:id', authAdmin, async (req, res) => {
  try {
    const user = await Patient.findById(req.params.id).select('-password') || await Doctor.findById(req.params.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('User fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/users/:id', authAdmin, async (req, res) => {
  try {
    const updates = req.body;
    const user = await Doctor.findByIdAndUpdate(req.params.id, updates, { new: true }) || await Patient.findByIdAndUpdate(req.params.id, updates, { new: true });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    console.error('User update error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deactivate Doctor Account
router.put('/doctors/deactivate/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Deactivation reason required' });

    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    doctor.accountStatus = 'deactivated';
    doctor.deactivationReason = reason;
    await doctor.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: doctor.email,
      subject: 'Account Deactivation - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>We regret to inform you that your account with TrueMedicine has been deactivated by our admin team.</p>
        <p><strong>Reason for deactivation:</strong> ${reason}</p>
        <p>Please contact our support team at support@truemedicine.com for further assistance or to reactivate your account.</p>
        <p>Thank you for your understanding.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Doctor account deactivated and email sent', doctor });
  } catch (err) {
    console.error('Doctor deactivate error:', err.stack);
    res.status(500).json({ error: 'Failed to deactivate doctor', details: err.message });
  }
});

router.put('/doctors/activate/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    // Check if the user is an admin (using req.admin from authAdmin middleware)
    if (!['admin', 'superadmin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Find the doctor using the Doctor model
    const doctor = await Doctor.findById(id);
    if (!doctor) {
      return res.status(404).json({ error: 'Doctor not found' });
    }

    // Check if already active
    if (doctor.accountStatus === 'active') {
      return res.status(400).json({ error: 'Doctor is already active' });
    }

    // Update doctor status
    doctor.accountStatus = 'active';
    doctor.deactivationReason = ''; // Clear the deactivation reason
    await doctor.save();

    // Send email notification (optional reason)
    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: doctor.email,
      subject: 'Your Doctor Account Has Been Activated - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>We are pleased to inform you that your account with TrueMedicine has been reactivated by our admin team.</p>
        ${reason ? `<p><strong>Reason for reactivation:</strong> ${reason}</p>` : ''}
        <p>You can now resume your activities on the platform. Log in at <a href="http://localhost:3000/doctor-login" style="color: #007bff; text-decoration: none;">this link</a>.</p>
        <p>If you have any questions, contact us at support@truemedicine.com.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'Doctor account activated and notified', doctor });
  } catch (error) {
    console.error('Activate doctor error:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Delete Doctor Account
router.delete('/doctors/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Deletion reason required' });

    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    doctor.accountStatus = 'deleted';
    doctor.deletionReason = reason;
    await doctor.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: doctor.email,
      subject: 'Account Deletion - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>We regret to inform you that your account with TrueMedicine has been deleted by our admin team.</p>
        <p><strong>Reason for deletion:</strong> ${reason}</p>
        <p>If you believe this is an error, please contact our support team at support@truemedicine.com.</p>
        <p>Thank you for your time with TrueMedicine.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    await Doctor.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Doctor account deleted and email sent' });
  } catch (err) {
    console.error('Doctor delete error:', err.stack);
    res.status(500).json({ error: 'Failed to delete doctor', details: err.message });
  }
});

// Doctor Management
router.get('/doctors/pending', authAdmin, async (req, res) => {
  try {
    const doctors = await Doctor.find({ isVerified: false, accountStatus: 'active' });
    res.json(doctors);
  } catch (err) {
    console.error('Pending doctors fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/doctors/verify/:id', authAdmin, async (req, res) => {
  try {
    const doctor = await Doctor.findByIdAndUpdate(req.params.id, { isVerified: true }, { new: true });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: doctor.email,
      subject: 'Account Verification Successful - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>We are pleased to inform you that your account with TrueMedicine has been successfully verified by our admin team.</p>
        <p>You can now log in to your dashboard and start managing your appointments and patient interactions.</p>
        <p><a href="http://localhost:3000/doctor-login" style="color: #007bff; text-decoration: none;">Click here to log in</a></p>
        <p>If you have any questions, feel free to contact us at support@truemedicine.com.</p>
        <p>Thank you for joining TrueMedicine!</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    console.log('Sending verification email to:', doctor.email);
    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Doctor successfully verified and email sent', doctor: doctor.toObject() });
  } catch (err) {
    console.error('Doctor verify error:', err.stack);
    res.status(500).json({ error: 'Failed to verify doctor', details: err.message });
  }
});

router.post('/doctors/reject/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason required' });

    const doctor = await Doctor.findById(req.params.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: doctor.email,
      subject: 'Account Verification Rejected - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>We regret to inform you that your account with TrueMedicine has not been verified by our admin team.</p>
        <p><strong>Reason for rejection:</strong> ${reason}</p>
        <p>If you believe this is an error or need further clarification, please contact us at support@truemedicine.com.</p>
        <p>You may reapply or update your documents if necessary by registering again at <a href="http://localhost:3000/doctor-signup" style="color: #007bff; text-decoration: none;">this link</a>.</p>
        <p>Thank you for your interest in TrueMedicine.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    console.log('Sending rejection email to:', doctor.email);
    await transporter.sendMail(mailOptions);

    await Doctor.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: 'Doctor successfully rejected and email sent', reason });
  } catch (err) {
    console.error('Doctor reject error:', err.stack);
    res.status(500).json({ error: 'Failed to reject doctor', details: err.message });
  }
});

// Appointments Management
// Get Canceled Appointments (Updated to filter by status)// Appointments Management (ensure compatibility with refund logic)
router.get('/appointments', authAdmin, async (req, res) => {
  try {
    const { state, city, startDate, endDate, status } = req.query;
    const appointmentFilter = {};
    if (state || city) {
      const doctorIds = (await Doctor.find({ ...(state ? { state } : {}), ...(city ? { city } : {}) }).select('_id')).map(doc => doc._id);
      appointmentFilter.doctorId = { $in: doctorIds };
    }
    if (startDate) appointmentFilter.date = { $gte: new Date(startDate) };
    if (endDate) appointmentFilter.date = { ...appointmentFilter.date, $lte: new Date(endDate) };
    if (status) appointmentFilter.status = status;

    const appointments = await Appointment.find(appointmentFilter)
      .populate('patientId', 'name')
      .populate('doctorId', 'name');
    res.json(appointments);
  } catch (err) {
    console.error('Appointments fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add these routes after the existing doctor-related routes in your backend code

// Deactivate Patient Account
router.put('/patients/deactivate/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Deactivation reason required' });

    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    if (patient.accountStatus === 'deactivated') {
      return res.status(400).json({ error: 'Patient is already deactivated' });
    }

    patient.accountStatus = 'deactivated';
    patient.deactivationReason = reason;
    await patient.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: patient.email,
      subject: 'Account Deactivation - TrueMedicine',
      html: `
        <h2>Hello ${patient.name},</h2>
        <p>We regret to inform you that your patient account with TrueMedicine has been deactivated by our admin team.</p>
        <p><strong>Reason for deactivation:</strong> ${reason}</p>
        <p>Please contact our support team at support@truemedicine.com for further assistance or to reactivate your account.</p>
        <p>Thank you for your understanding.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Patient account deactivated and email sent', patient });
  } catch (err) {
    console.error('Patient deactivate error:', err.stack);
    res.status(500).json({ error: 'Failed to deactivate patient', details: err.message });
  }
});

// Activate Patient Account
router.put('/patients/activate/:id', authAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    if (!['admin', 'superadmin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const patient = await Patient.findById(id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    if (patient.accountStatus === 'active') {
      return res.status(400).json({ error: 'Patient is already active' });
    }

    patient.accountStatus = 'active';
    patient.deactivationReason = '';
    await patient.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: patient.email,
      subject: 'Your Patient Account Has Been Activated - TrueMedicine',
      html: `
        <h2>Hello ${patient.name},</h2>
        <p>We are pleased to inform you that your patient account with TrueMedicine has been reactivated by our admin team.</p>
        ${reason ? `<p><strong>Reason for reactivation:</strong> ${reason}</p>` : ''}
        <p>You can now resume your activities on the platform. Log in at <a href="http://localhost:3000/login?type=patient" style="color: #007bff; text-decoration: none;">this link</a>.</p>
        <p>If you have any questions, contact us at support@truemedicine.com.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);

    res.status(200).json({ message: 'Patient account activated and notified', patient });
  } catch (error) {
    console.error('Activate patient error:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Add this after the activate/deactivate patient routes in admin.js

// Ban Patient Account
router.put('/patients/ban/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Ban reason required' });

    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    if (patient.accountStatus === 'banned') {
      return res.status(400).json({ error: 'Patient is already banned' });
    }

    patient.accountStatus = 'banned';
    patient.deactivationReason = reason; // Reuse this field for ban reason
    await patient.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: patient.email,
      subject: 'Account Banned - TrueMedicine',
      html: `
        <h2>Hello ${patient.name},</h2>
        <p>We regret to inform you that your patient account with TrueMedicine has been banned by our admin team.</p>
        <p><strong>Reason for ban:</strong> ${reason}</p>
        <p>Please contact our support team at support@truemedicine.com if you believe this is an error or for further clarification.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Patient account banned and email sent', patient });
  } catch (err) {
    console.error('Patient ban error:', err.stack);
    res.status(500).json({ error: 'Failed to ban patient', details: err.message });
  }
});




// Unban Patient Account
router.put('/patients/unban/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!['admin', 'superadmin'].includes(req.admin.role)) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    const patient = await Patient.findById(req.params.id);
    if (!patient) {
      return res.status(404).json({ error: 'Patient not found' });
    }

    if (patient.accountStatus !== 'banned') {
      return res.status(400).json({ error: 'Patient is not banned' });
    }

    patient.accountStatus = 'active';
    patient.deactivationReason = ''; // Clear the ban reason
    await patient.save();

    const senderEmail = process.env.EMAIL_USER;
    if (!senderEmail || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'SMTP credentials not configured in environment variables' });
    }

    const mailOptions = {
      from: `"TrueMedicine" <${senderEmail}>`,
      to: patient.email,
      subject: 'Your Account Has Been Unbanned - TrueMedicine',
      html: `
        <h2>Hello ${patient.name},</h2>
        <p>We are pleased to inform you that your patient account with TrueMedicine has been unbanned by our admin team.</p>
        ${reason ? `<p><strong>Reason for unbanning:</strong> ${reason}</p>` : ''}
        <p>You can now resume your activities on the platform. Log in at <a href="http://localhost:3000/login?type=patient" style="color: #007bff; text-decoration: none;">this link</a>.</p>
        <p>If you have any questions, contact us at support@truemedicine.com.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
        <hr>
        <p style="font-size: 0.8em; color: #666;">This is an automated email, please do not reply directly.</p>
      `,
    };

    await transporter.sendMail(mailOptions);
    res.status(200).json({ message: 'Patient account unbanned and notified', patient });
  } catch (err) {
    console.error('Patient unban error:', err.stack);
    res.status(500).json({ error: 'Failed to unban patient', details: err.message });
  }
});



router.get('/appointments/doctor/:doctorId', authAdmin, async (req, res) => {
  try {
    const appointments = await Appointment.find({ doctorId: req.params.doctorId })
      .populate('patientId', 'name');
    res.json(appointments);
  } catch (err) {
    console.error('Doctor appointments fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Updated Endpoint: Fetch Patient Appointments with Proper Payment Details
// ... (other imports and setup remain unchanged)

// Updated Endpoint: Fetch Patient Appointments
router.get('/appointments/patient/:patientId', authAdmin, async (req, res) => {
  try {
    const appointments = await Appointment.find({ patientId: req.params.patientId })
      .populate('doctorId', 'name')
      .populate('patientId', 'name email');

    if (!appointments || appointments.length === 0) {
      return res.json([]);
    }

    const appointmentsWithPaymentDetails = await Promise.all(
      appointments.map(async (appointment) => {
        let paymentDetails = appointment.paymentDetails || {};

        // Ensure paymentDetails is populated for 'paid' or 'refunded' statuses
        if (
          ['paid', 'refunded'].includes(appointment.paymentStatus) &&
          (!paymentDetails.paymentId || !paymentDetails.amountPaid || !paymentDetails.paidAt)
        ) {
          try {
            const payment = await razorpay.payments.fetch(
              appointment.paymentDetails?.paymentId || appointment.transactionId
            );
            paymentDetails = {
              paymentId: payment.id,
              amountPaid: payment.amount / 100, // Convert paise to INR
              status: payment.status === 'captured' ? 'paid' : payment.status,
              method: payment.method || 'Unknown',
              transactionId: payment.id,
              paidAt: new Date(payment.created_at * 1000).toISOString(),
              invoicePath: paymentDetails.invoicePath || null,
            };

            // Update paymentDetails in the database
            await Appointment.updateOne(
              { _id: appointment._id },
              { $set: { paymentDetails } }
            );
          } catch (error) {
            console.error(`Failed to fetch payment details for appointment ${appointment._id}: ${error.message}`);
            // Fallback to sensible defaults
            paymentDetails = {
              paymentId: appointment.paymentDetails?.paymentId || appointment.transactionId || 'N/A',
              amountPaid: appointment.totalFee || 0, // Use totalFee as fallback
              status: appointment.paymentStatus || 'paid',
              method: paymentDetails.method || 'Unknown',
              transactionId: appointment.paymentDetails?.transactionId || 'N/A',
              paidAt: appointment.paymentDetails?.paidAt || appointment.createdAt || new Date().toISOString(),
              invoicePath: paymentDetails.invoicePath || null,
            };

            // Migrate paymentDate to paidAt if it exists
            if (appointment.paymentDetails?.paymentDate && !paymentDetails.paidAt) {
              paymentDetails.paidAt = appointment.paymentDetails.paymentDate;
            }

            // Update paymentDetails with fallback data
            await Appointment.updateOne(
              { _id: appointment._id },
              { $set: { paymentDetails } }
            );
          }
        }

        return {
          ...appointment.toObject(),
          paymentDetails,
        };
      })
    );

    res.json(appointmentsWithPaymentDetails);
  } catch (err) {
    console.error('Patient appointments fetch error:', err.stack);
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: err.errors,
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// [Add this new endpoint to handle payment creation if not already present elsewhere]
// ... (other imports and setup remain unchanged)

// Updated Endpoint: Book an Appointment
// ... (other imports and setup remain unchanged)

// Updated Endpoint: Book an Appointment
router.post('/appointments/book', authAdmin, async (req, res) => {
  try {
    const { patientId, doctorId, date, consultationFee, type } = req.body;

    // Validate required fields from the request
    if (!patientId || !doctorId || !date || !consultationFee || !type) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'patientId, doctorId, date, consultationFee, and type are required',
      });
    }

    // Fetch platform settings for commission rates, with defaults if not found
    const settings = await PlatformSettings.findOne() || {
      patientCommission: 30, // Default patient commission rate (30%)
      doctorCommission: 10, // Default doctor commission rate (10%)
    };

    const patientCommissionRate = settings.patientCommission / 100; // Convert percentage to decimal
    const doctorCommissionRate = settings.doctorCommission / 100;   // Convert percentage to decimal
    const totalFee = consultationFee + (consultationFee * patientCommissionRate); // Total fee including commission

    // Create Razorpay order
    const order = await razorpay.orders.create({
      amount: Math.round(totalFee * 100), // Convert INR to paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}`,
    });

    // Simulate payment success (replace with actual payment flow in production)
    const payment = {
      id: `pay_${Date.now()}`,
      order_id: order.id,
      amount: Math.round(totalFee * 100),
      status: 'captured',
      method: 'UPI',
      created_at: Math.floor(Date.now() / 1000),
    };

    // Create appointment with all required fields
    const appointment = new Appointment({
      patientId,
      doctorId,
      date: new Date(date),
      consultationFee: Number(consultationFee), // Ensure it's a number
      totalFee: Number(totalFee),              // Ensure it's a number
      patientCommissionRate: Number(patientCommissionRate), // Store as decimal (e.g., 0.3)
      doctorCommissionRate: Number(doctorCommissionRate),   // Store as decimal (e.g., 0.1)
      paymentStatus: 'paid',
      paymentDetails: {
        paymentId: payment.id,
        amountPaid: payment.amount / 100, // Convert paise to INR
        status: 'paid',
        method: payment.method,
        transactionId: payment.id,
        paymentDate: new Date(payment.created_at * 1000).toISOString(),
      },
      type,
      status: 'pending',
      createdAt: new Date(),
    });

    // Save the appointment and handle validation errors
    await appointment.save();

    res.json({
      message: 'Appointment booked and payment processed successfully',
      appointment,
    });
  } catch (err) {
    console.error('Appointment booking error:', err.stack);
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        error: 'Validation failed',
        details: err.errors,
      });
    }
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});


// Doctors' Earnings Overview
// Doctors' Earnings Overview
router.get('/doctors/earnings', authAdmin, async (req, res) => {
  try {
    const doctors = await Doctor.find();
    if (!doctors.length) {
      return res.status(404).json({ error: 'No doctors found' });
    }

    const earnings = await Promise.all(doctors.map(async (doc) => {
      const appointments = await Appointment.find({ doctorId: doc._id, status: 'completed' });
      const totalEarnings = appointments.reduce((sum, app) => sum + (app.consultationFee || 0), 0);
      const settings = await PlatformSettings.findOne() || { doctorCommission: 10 };
      const commissionRate = settings.doctorCommission / 100;
      const netEarnings = totalEarnings * (1 - commissionRate);
      const withdrawals = await Withdrawal.find({ doctorId: doc._id });
      const totalWithdrawn = withdrawals
        .filter(w => w.status === 'approved')
        .reduce((sum, w) => sum + w.amount, 0);

      return {
        _id: doc._id,
        name: doc.name,
        email: doc.email,
        totalEarnings: netEarnings, // Net earnings after commission
        pendingEarnings: netEarnings - totalWithdrawn,
        totalWithdrawn,
      };
    }));

    res.json(earnings);
  } catch (err) {
    console.error('Earnings fetch error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});


// New Endpoint: Get Doctor Payment Details
// backend/routes/admin.js
// New Endpoint: Get Doctor Payment Details
// Ensure /admin/doctor-payment-details/:doctorId is correct (already present but verified here)
router.get('/doctor-payment-details/:doctorId', authAdmin, async (req, res) => {
  try {
    // Fetch doctor details
    const doctor = await Doctor.findById(req.params.doctorId).select(
      'name email phone specialization state city experience address consultationFee bankDetails'
    );
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    // Fetch completed appointments for this doctor
    const appointments = await Appointment.find({ 
      doctorId: req.params.doctorId, 
      status: 'completed' 
    }).lean();

    // Log appointments for debugging
    console.log(`Appointments found: ${appointments.length}`, appointments.map(a => a.consultationFee));

    // Fetch platform settings for default commission rates
    const settings = await PlatformSettings.findOne() || { patientCommission: 30, doctorCommission: 10 };

    // Calculate earnings
    let totalEarningsBeforeFees = 0;
    let platformDeductionFromDoctors = 0;
    let netDoctorEarnings = 0;

    appointments.forEach((app) => {
      const baseFee = app.consultationFee || 0;
      const doctorCommissionRate = (app.doctorCommissionRate !== undefined ? app.doctorCommissionRate : settings.doctorCommission) / 100;
      const doctorCommission = baseFee * doctorCommissionRate;

      totalEarningsBeforeFees += baseFee;
      platformDeductionFromDoctors += doctorCommission;
      netDoctorEarnings += (baseFee - doctorCommission);
    });

    // Fetch withdrawals
    const withdrawals = await Withdrawal.find({ doctorId: req.params.doctorId }).lean();
    const totalWithdrawn = withdrawals
      .filter(w => w.status === 'approved')
      .reduce((sum, w) => sum + (w.approvedAmount || w.amount || 0), 0);
    const pendingEarnings = netDoctorEarnings - totalWithdrawn;
    const availableBalance = pendingEarnings > 0 ? pendingEarnings : 0;

    // Log calculated values for debugging
    console.log({
      totalEarningsBeforeFees,
      platformDeductionFromDoctors,
      netDoctorEarnings,
      totalWithdrawn,
      pendingEarnings,
      availableBalance
    });

    // Response
    res.json({
      name: doctor.name || 'N/A',
      email: doctor.email || 'N/A',
      phone: doctor.phone || 'N/A',
      specialization: doctor.specialization || 'N/A',
      state: doctor.state || 'N/A',
      city: doctor.city || 'N/A',
      experience: doctor.experience || 0,
      address: doctor.address || 'N/A',
      consultationFee: doctor.consultationFee || 0,
      bankDetails: doctor.bankDetails || {},
      summary: {
        totalEarningsBeforeFees,
        platformDeductionFromDoctors,
        netDoctorEarnings,
        totalWithdrawn,
        pendingEarnings,
        availableBalance,
        completedAppointments: appointments.length
      }
    });
  } catch (err) {
    console.error('Doctor payment details fetch error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// New Endpoint: Get Doctor Withdrawals
// Updated Endpoint: Get Doctor Withdrawals
router.get('/withdrawals/doctor/:doctorId', authAdmin, async (req, res) => {
  try {
    const withdrawals = await Withdrawal.find({ doctorId: req.params.doctorId });
    const formattedWithdrawals = withdrawals.map(w => ({
      _id: w._id,
      doctorId: w.doctorId,
      amount: w.amount,
      method: w.method || 'N/A',
      status: w.status,
      requestDate: w.requestDate,
      transactionId: w.transactionId || null,
      paymentMode: w.paymentMode || null,
      approvedAmount: w.approvedAmount || null,
      dateOfPayment: w.dateOfPayment || null,
      rejectionReason: w.rejectionReason || null,
      dateOfRejection: w.dateOfRejection || null,
      invoicePath: w.invoicePath || null, // Include invoice path
    }));
    res.json(formattedWithdrawals);
  } catch (err) {
    console.error('Doctor withdrawals fetch error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Withdrawal Requests
// Withdrawal Requests
// Withdrawals Management (Updated with Filters)
router.get('/withdrawals', authAdmin, async (req, res) => {
  try {
    const { state, city } = req.query;
    const withdrawalFilter = {};
    if (state || city) {
      const doctorIds = (await Doctor.find({ ...(state ? { state } : {}), ...(city ? { city } : {}) }).select('_id')).map(doc => doc._id);
      withdrawalFilter.doctorId = { $in: doctorIds };
    }

    const withdrawals = await Withdrawal.find(withdrawalFilter).populate('doctorId', 'name state city email');
    const result = withdrawals.map(w => ({
      _id: w._id,
      doctorId: w.doctorId?._id || 'N/A',
      doctorName: w.doctorId?.name || 'Unknown',
      state: w.doctorId?.state || 'N/A',
      city: w.doctorId?.city || 'N/A',
      amount: w.amount,
      method: w.method,
      status: w.status,
      requestDate: w.requestDate,
      rejectionReason: w.rejectionReason || '',
      dateOfPayment: w.dateOfPayment || null,
      dateOfRejection: w.dateOfRejection || null,
      transactionId: w.transactionId || null,
      paymentMode: w.paymentMode || null,
      approvedAmount: w.approvedAmount || null,
      appointmentId: w.appointmentId || null,
    }));
    res.json(result);
  } catch (err) {
    console.error('Withdrawals fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Approve Withdrawal
// Approve Withdrawal Endpoint
// Approve Withdrawal Endpoint
// Approve Withdrawal Endpoint
// Approve Withdrawal Endpoint
// Approve Withdrawal Endpoint in adminroutes.js
router.put('/withdrawals/approve/:id', authAdmin, async (req, res) => {
  try {
    const { transactionId, paymentMode, paidAmount, dateOfPayment } = req.body;

    // Validate required fields
    if (!transactionId || !paymentMode || !paidAmount || !dateOfPayment) {
      return res.status(400).json({ error: 'Missing required fields: transactionId, paymentMode, paidAmount, dateOfPayment' });
    }

    const withdrawal = await Withdrawal.findById(req.params.id).populate('doctorId', 'name email');
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }
    if (withdrawal.status !== 'pending') {
      return res.status(400).json({ error: 'Withdrawal is not pending' });
    }

    // Generate Invoice PDF
    const doc = new PDFDocument();
    const invoiceFileName = `invoices/withdrawal_${withdrawal._id}.pdf`; // Consistent naming
    const invoicePath = `${process.env.B2_BUCKET_NAME}/${invoiceFileName}`;
    const buffers = [];
    doc.on('data', buffers.push.bind(buffers));

    // Write invoice content
    doc.fontSize(20).text('TrueMedicine Withdrawal Invoice', { align: 'center' });
    doc.fontSize(12).text(`Withdrawal ID: ${withdrawal._id}`, { align: 'left' });
    doc.text(`Doctor: ${withdrawal.doctorId.name}`, { align: 'left' });
    doc.text(`Amount Requested: ₹${withdrawal.amount}`, { align: 'left' });
    doc.text(`Amount Paid: ₹${paidAmount}`, { align: 'left' });
    doc.text(`Transaction ID: ${transactionId}`, { align: 'left' });
    doc.text(`Payment Mode: ${paymentMode}`, { align: 'left' });
    doc.text(`Date of Payment: ${new Date(dateOfPayment).toLocaleString()}`, { align: 'left' });
    doc.end();

    // Wait for PDF generation to complete
    await new Promise((resolve) => doc.on('end', resolve));
    const pdfBuffer = Buffer.concat(buffers);

    // Upload to Backblaze B2
    await b2.authorize();
    const uploadUrlResponse = await b2.getUploadUrl({ bucketId: b2BucketId });
    const uploadResponse = await b2.uploadFile({
      uploadUrl: uploadUrlResponse.data.uploadUrl,
      uploadAuthToken: uploadUrlResponse.data.authorizationToken,
      fileName: invoiceFileName, // Store as invoices/withdrawal_<id>.pdf
      data: pdfBuffer,
      contentType: 'application/pdf',
    });
    console.log('B2 Upload Response:', uploadResponse.data);

    // Update Withdrawal with invoice path and approval details
    withdrawal.status = 'approved';
    withdrawal.transactionId = transactionId;
    withdrawal.paymentMode = paymentMode;
    withdrawal.approvedAmount = paidAmount;
    withdrawal.dateOfPayment = new Date(dateOfPayment);
    withdrawal.invoicePath = invoiceFileName; // Store relative path
    await withdrawal.save();

    // Send approval email with invoice attachment
    const mailOptions = {
      from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
      to: withdrawal.doctorId.email,
      subject: 'Withdrawal Approved - TrueMedicine',
      html: `
        <h2>Hello Dr. ${withdrawal.doctorId.name},</h2>
        <p>Your withdrawal request of ₹${withdrawal.amount} has been approved.</p>
        <p><strong>Transaction ID:</strong> ${transactionId}</p>
        <p><strong>Payment Mode:</strong> ${paymentMode}</p>
        <p><strong>Amount Paid:</strong> ₹${paidAmount}</p>
        <p><strong>Date of Payment:</strong> ${new Date(dateOfPayment).toLocaleString()}</p>
        <p>Please find the invoice attached for your records.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
      `,
      attachments: [
        {
          filename: `withdrawal_invoice_${withdrawal._id}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        },
      ],
    };
    await transporter.sendMail(mailOptions);

    res.json({
      message: 'Withdrawal approved and invoice sent',
      withdrawal: {
        _id: withdrawal._id,
        doctorId: withdrawal.doctorId._id,
        amount: withdrawal.amount,
        status: withdrawal.status,
        invoicePath: withdrawal.invoicePath,
        transactionId,
        paymentMode,
        approvedAmount: paidAmount,
        dateOfPayment,
      },
    });
  } catch (err) {
    console.error('Withdrawal approval error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Download Receipt Endpoint
// Add this after the `/withdrawals/approve/:id` route
router.get('/withdrawals/invoice/:withdrawalId', authAdmin, async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.withdrawalId);
    if (!withdrawal) {
      return res.status(404).json({ error: 'Withdrawal not found' });
    }

    const filePath = withdrawal.invoicePath;
    if (!filePath) {
      return res.status(404).json({ error: 'Invoice not found for this withdrawal' });
    }

    // Check Backblaze B2 initialization
    if (!b2BucketId || !b2ApiUrl) {
      console.warn('Backblaze B2 not initialized, attempting reinitialization');
      await initializeB2();
    }

    // Get download authorization
    const { data: auth } = await b2.getDownloadAuthorization({
      bucketId: b2BucketId,
      fileNamePrefix: filePath.replace(`${process.env.B2_BUCKET_NAME}/`, ''),
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    // Construct the direct download URL
    const downloadUrl = `${b2DownloadUrl}/file/${process.env.B2_BUCKET_NAME}/${filePath.replace(`${process.env.B2_BUCKET_NAME}/`, '')}?Authorization=${auth.authorizationToken}`;

    // Return the URL instead of streaming (client can handle the download)
    res.json({ url: downloadUrl });
  } catch (err) {
    console.error('Invoice download error:', {
      message: err.message,
      stack: err.stack,
      withdrawalId: req.params.withdrawalId,
    });
    res.status(500).json({
      error: 'Failed to fetch invoice download URL',
      details: err.message,
    });
  }
});

// Add a route to download the receipt
router.get('/withdrawals/receipt/:withdrawalId', authAdmin, async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.withdrawalId);
    if (!withdrawal || !withdrawal.receiptPath) {
      return res.status(404).json({ error: 'Receipt not found' });
    }

    // Authorize with Backblaze B2 if not already done
    if (!b2BucketId) {
      await b2.authorize();
      const bucketResponse = await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME });
      b2BucketId = bucketResponse.data.buckets[0].bucketId;
    }

    // Get download authorization
    const { data: auth } = await b2.getDownloadAuthorization({
      bucketId: b2BucketId,
      fileNamePrefix: withdrawal.receiptPath.replace(`${process.env.B2_BUCKET_NAME}/`, ''),
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    // Construct the direct download URL
    const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${withdrawal.receiptPath.replace(`${process.env.B2_BUCKET_NAME}/`, '')}?Authorization=${auth.authorizationToken}`;

    // Return the URL for the frontend to handle
    res.json({ url: downloadUrl });
  } catch (err) {
    console.error('Receipt download error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// New Endpoint: Download Invoice
// Download Invoice Endpoint
router.get('/withdrawals/invoice/:id', authAdmin, async (req, res) => {
  try {
    const withdrawal = await Withdrawal.findById(req.params.id);
    if (!withdrawal || !withdrawal.invoicePath) return res.status(404).json({ error: 'Invoice not found' });
    res.download(withdrawal.invoicePath, `invoice_${withdrawal._id}.pdf`);
  } catch (err) {
    console.error('Invoice download error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Reject Withdrawal Endpoint
router.put('/withdrawals/reject/:id', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Rejection reason required' });

    const withdrawal = await Withdrawal.findById(req.params.id).populate('doctorId', 'email name');
    if (!withdrawal) return res.status(404).json({ error: 'Withdrawal not found' });
    if (withdrawal.status !== 'pending') return res.status(400).json({ error: 'Withdrawal already processed' });

    withdrawal.status = 'rejected';
    withdrawal.rejectionReason = reason;
    withdrawal.dateOfRejection = new Date();

    await withdrawal.save();

    await transporter.sendMail({
      from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
      to: withdrawal.doctorId.email,
      subject: 'Withdrawal Request Rejected - TrueMedicine',
      html: `
        <h2>Hello Dr. ${withdrawal.doctorId.name},</h2>
        <p>Your withdrawal request of ₹${withdrawal.amount} has been rejected.</p>
        <p><strong>Reason:</strong> ${reason}</p>
        <p><strong>Date of Rejection:</strong> ${new Date().toLocaleDateString()}</p>
        <p>Please contact support@truemedicine.com if you have any questions.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
      `,
    });

    res.json({ 
      message: 'Withdrawal rejected',
      withdrawal: {
        ...withdrawal.toObject(),
        status: 'rejected',
        rejectionReason: reason,
        dateOfRejection: withdrawal.dateOfRejection,
      }
    });
  } catch (err) {
    console.error('Withdrawal reject error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Payment Settings
router.get('/payment-settings', authAdmin, async (req, res) => {
  res.json({ commissionRate: 30, minWithdrawal: 500 }); // Hardcoded for now; replace with DB if needed
});

router.put('/payment-settings', authAdmin, async (req, res) => {
  const { commissionRate, minWithdrawal } = req.body;
  // Save to DB if implemented; for now, just return success
  res.json({ message: 'Settings updated', commissionRate, minWithdrawal });
});

// backend/routes/admin.js
router.put('/appointments/update-commissions', authAdmin, async (req, res) => {
  try {
    const settings = await PlatformSettings.findOne();
    if (!settings) {
      return res.status(404).json({ error: 'PlatformSettings not found' });
    }

    const appointments = await Appointment.find({ status: 'pending' }); // Or adjust query as needed
    const updatedCount = await Promise.all(appointments.map(async (app) => {
      const patientCommissionFraction = settings.patientCommission / 100;
      app.patientCommissionRate = settings.patientCommission;
      app.doctorCommissionRate = settings.doctorCommission;
      app.totalFee = app.consultationFee + (app.consultationFee * patientCommissionFraction);
      await app.save();
      return 1;
    }));

    res.json({ message: 'Appointments updated with latest commission rates', updatedCount: updatedCount.length });
  } catch (err) {
    console.error('Commission update error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Payments Management
router.get('/payments', authAdmin, async (req, res) => {
  try {
    const appointments = await Appointment.find({ paymentStatus: 'paid' })
      .populate('patientId', 'name')
      .populate('doctorId', 'name');
    const payments = appointments.map(app => ({
      appointmentId: app._id,
      patient: app.patientId?.name || 'N/A',
      doctor: app.doctorId?.name || 'N/A',
      totalFee: app.totalFee || 0,
      paymentStatus: app.paymentStatus,
    }));
    res.json(payments);
  } catch (err) {
    console.error('Payments fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/payments/doctor/:doctorId', authAdmin, async (req, res) => {
  try {
    const doctorId = req.params.doctorId;
    const appointments = await Appointment.find({ doctorId });
    const totalEarnings = appointments.reduce((sum, app) => sum + (app.totalFee || 0), 0);
    const paidEarnings = appointments.filter(app => app.paymentStatus === 'paid').reduce((sum, app) => sum + (app.totalFee || 0), 0);
    const commissionRate = 0.2;
    const commission = totalEarnings * commissionRate;
    res.json({
      totalEarnings,
      pendingPayouts: totalEarnings - paidEarnings,
      commission,
    });
  } catch (err) {
    console.error('Doctor payments fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update /admin/payments/payout/:doctorId to create a withdrawal record
router.post('/payments/payout/:doctorId', authAdmin, async (req, res) => {
  try {
    const doctorId = req.params.doctorId;

    // Fetch doctor payment details to get available balance
    const earningsRes = await api.get(`/admin/doctor-payment-details/${doctorId}`, {
      headers: { Authorization: `Bearer ${req.admin.accessToken}` },
    });
    const availableBalance = earningsRes.data.summary.availableBalance;

    if (availableBalance <= 0) {
      return res.status(400).json({ error: 'No pending payouts available' });
    }

    // Create a withdrawal request
    const withdrawal = new Withdrawal({
      doctorId,
      amount: availableBalance,
      method: 'manual', // Assuming manual payout by admin
      status: 'approved',
      requestDate: new Date(),
      transactionId: `TXN${Date.now()}`, // Placeholder; replace with real transaction ID if available
      paymentMode: 'Bank Transfer', // Placeholder; adjust as needed
      approvedAmount: availableBalance,
      dateOfPayment: new Date(),
    });

    // Generate Invoice PDF
    const doc = new PDFDocument();
    const invoicePath = path.join(invoiceDir, `invoice_${withdrawal._id}.pdf`);
    const stream = fs.createWriteStream(invoicePath);
    doc.pipe(stream);

    const doctor = await Doctor.findById(doctorId);
    doc.fontSize(20).text('TrueMedicine', { align: 'center' });
    doc.fontSize(14).text('Payment Invoice', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Invoice Date: ${new Date().toLocaleDateString()}`);
    doc.text(`Invoice Number: INV-${withdrawal._id}`);
    doc.moveDown();
    doc.text(`Doctor Name: Dr. ${doctor.name}`);
    doc.text(`Bank Name: ${doctor.bankDetails.bankName || 'N/A'}`);
    doc.text(`Account Number: **** **** **** ${doctor.bankDetails.accountNumber?.slice(-4) || 'N/A'}`);
    doc.text(`IFSC Code: ${doctor.bankDetails.ifscCode || 'N/A'}`);
    doc.moveDown();
    doc.text(`Approved Amount: ₹${availableBalance.toFixed(2)}`);
    doc.text(`Payment Mode: ${withdrawal.paymentMode}`);
    doc.text(`Transaction ID: ${withdrawal.transactionId}`);
    doc.text(`Payment Date: ${new Date().toLocaleDateString()}`);
    doc.moveDown();
    doc.text('Admin Signature: ____________________');
    doc.text('Official Stamp: ____________________');
    doc.end();

    await new Promise(resolve => stream.on('finish', resolve));
    withdrawal.invoicePath = invoicePath;
    await withdrawal.save();

    // Update doctor's bank details
    await Doctor.findByIdAndUpdate(doctorId, { 'bankDetails.lastPaymentDate': new Date() });

    // Send email with invoice
    await transporter.sendMail({
      from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
      to: doctor.email,
      subject: 'Payout Processed - TrueMedicine',
      html: `
        <h2>Hello Dr. ${doctor.name},</h2>
        <p>Your payout of ₹${availableBalance.toFixed(2)} has been processed successfully.</p>
        <p>Please find the attached invoice for your records.</p>
        <p>Best regards,<br>The TrueMedicine Team</p>
      `,
      attachments: [{ filename: `invoice_${withdrawal._id}.pdf`, path: invoicePath }],
    });

    res.json({ message: 'Payout processed successfully', withdrawal });
    } catch (err) {
      console.error('Payout error:', err.stack);
      res.status(500).json({ error: 'Server error', details: err.message });
    }
  });

// Reviews Management
router.get('/reviews/doctor/:doctorId', authAdmin, async (req, res) => {
  try {
    const reviews = await Feedback.find({ doctorId: req.params.doctorId });
    const averageRating = reviews.length ? (reviews.reduce((sum, r) => sum + (r.rating || 0), 0) / reviews.length).toFixed(1) : 0;
    res.json({ averageRating, reviews });
  } catch (err) {
    console.error('Reviews fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Reports
// backend/routes/admin.js

// Reports Endpoint with State and City Filters
// backend/routes/admin.js
// Reports Endpoint (Updated with New Financial Metrics)
// backend/routes/admin.js
router.get('/reports', authAdmin, async (req, res) => {
  try {
    const { state, city, startDate, endDate } = req.query;

    const userFilter = { state, city };
    const appointmentFilter = {};
    if (state || city) {
      const doctorIds = (await Doctor.find(userFilter).select('_id')).map(doc => doc._id);
      appointmentFilter.doctorId = { $in: doctorIds };
    }
    if (startDate) appointmentFilter.date = { $gte: new Date(startDate) };
    if (endDate) appointmentFilter.date = { ...appointmentFilter.date, $lte: new Date(endDate) };

    const settings = (await PlatformSettings.findOne()) || { patientCommission: 30, doctorCommission: 10 };
    const doctorCommissionRate = settings.doctorCommission / 100;
    const patientCommissionRate = settings.patientCommission / 100;

    // Basic Metrics
    const totalPatients = await Patient.countDocuments(userFilter);
    const totalDoctors = await Doctor.countDocuments({ ...userFilter, accountStatus: { $ne: 'deleted' } });
    const totalAppointments = await Appointment.countDocuments(appointmentFilter);
    const completedAppointments = await Appointment.countDocuments({ ...appointmentFilter, status: 'completed' });
    const canceledAppointments = await Appointment.countDocuments({ ...appointmentFilter, status: 'canceled' });
    const rescheduledAppointments = await Appointment.countDocuments({ ...appointmentFilter, status: 'rescheduled' });

    // Monthly Revenue and Appointments
    const monthlyRevenue = await Appointment.aggregate([
      { $match: { ...appointmentFilter, paymentStatus: 'paid' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, revenue: { $sum: '$totalFee' } } },
      { $sort: { '_id': 1 } },
      { $project: { month: '$_id', revenue: 1, _id: 0 } },
    ]);

    const monthlyAppointments = await Appointment.aggregate([
      { $match: { ...appointmentFilter, status: 'completed' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, count: { $sum: 1 } } },
      { $sort: { '_id': 1 } },
      { $project: { month: '$_id', count: 1, _id: 0 } },
    ]);

    const revenueGrowth = await Appointment.aggregate([
      { $match: { ...appointmentFilter, paymentStatus: 'paid' } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, revenue: { $sum: '$totalFee' } } },
      { $sort: { '_id': 1 } },
      { $limit: 24 }, // Last 2 years
      { $project: { month: '$_id', revenue: 1, _id: 0 } },
    ]);

    const refundCancellationTrend = await Appointment.aggregate([
      { $match: { ...appointmentFilter, $or: [{ status: 'canceled' }, { paymentStatus: 'refunded' }] } },
      { $group: { _id: { $dateToString: { format: '%Y-%m', date: '$date' } }, cancellations: { $sum: { $cond: [{ $eq: ['$status', 'canceled'] }, 1, 0] } }, refunds: { $sum: { $cond: [{ $eq: ['$paymentStatus', 'refunded'] }, '$totalFee', 0] } } } },
      { $sort: { '_id': 1 } },
      { $project: { month: '$_id', cancellations: 1, refunds: 1, _id: 0 } },
    ]);

    // Total Revenue and Refunds
    const totalRevenueAgg = await Appointment.aggregate([{ $match: { ...appointmentFilter, paymentStatus: 'paid' } }, { $group: { _id: null, total: { $sum: '$totalFee' } } }]);
    const totalRevenue = totalRevenueAgg[0]?.total || 0;

    const totalRefundsAgg = await Appointment.aggregate([{ $match: { ...appointmentFilter, paymentStatus: 'refunded' } }, { $group: { _id: null, total: { $sum: '$refundDetails.amount' || { $subtract: ['$totalFee', 50] } } } }]);
    const totalRefunds = totalRefundsAgg[0]?.total || 0;

    // Payment Mode Breakdown
    const paymentModeBreakdownAgg = await Appointment.aggregate([
      { $match: { ...appointmentFilter, paymentStatus: 'paid' } },
      { $group: { _id: '$paymentDetails.method', total: { $sum: '$totalFee' } } },
      { $project: { method: '$_id', total: 1, _id: 0 } },
    ]);

    const paymentModeBreakdown = {
      UPI: 0,
      'Credit/Debit Card': 0,
      'Net Banking': 0,
      Wallets: 0,
    };
    paymentModeBreakdownAgg.forEach(mode => {
      switch (mode.method) {
        case 'UPI':
          paymentModeBreakdown.UPI = mode.total;
          break;
        case 'Card':
          paymentModeBreakdown['Credit/Debit Card'] = mode.total;
          break;
        case 'Net Banking':
          paymentModeBreakdown['Net Banking'] = mode.total;
          break;
        case 'Wallets':
          paymentModeBreakdown.Wallets = mode.total;
          break;
        default:
          break;
      }
    });

    // Top Earning Specialties (Updated to Net Doctor Earnings)
    const topSpecialtiesAgg = await Appointment.aggregate([
      { $match: { ...appointmentFilter, status: 'completed' } }, // Only completed appointments
      { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' } },
      { $unwind: '$doctor' },
      {
        $group: {
          _id: '$doctor.specialization',
          netDoctorEarnings: {
            $sum: {
              $multiply: [
                '$consultationFee',
                { $subtract: [1, { $ifNull: ['$doctorCommissionRate', doctorCommissionRate] }] }
              ]
            }
          }
        }
      },
      { $sort: { netDoctorEarnings: -1 } },
      { $limit: 5 },
      { $project: { specialty: '$_id', netDoctorEarnings: 1, _id: 0 } },
    ]);

    // Top Earning Doctors (Updated to Net Earnings)
    const topEarningDoctorsAgg = await Appointment.aggregate([
      { $match: { ...appointmentFilter, status: 'completed' } },
      { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' } },
      { $unwind: '$doctor' },
      {
        $group: {
          _id: '$doctorId',
          netEarnings: {
            $sum: {
              $multiply: [
                '$consultationFee',
                { $subtract: [1, { $ifNull: ['$doctorCommissionRate', doctorCommissionRate] }] }
              ]
            }
          },
          name: { $first: '$doctor.name' },
          specialization: { $first: '$doctor.specialization' }
        }
      },
      { $sort: { netEarnings: -1 } },
      { $limit: 10 },
      { $project: { name: 1, specialization: 1, netEarnings: 1, _id: 0 } },
    ]);

    // Top Revenue States
    const topRevenueStatesAgg = await Appointment.aggregate([
      { $match: { ...appointmentFilter, paymentStatus: 'paid' } },
      { $lookup: { from: 'doctors', localField: 'doctorId', foreignField: '_id', as: 'doctor' } },
      { $unwind: '$doctor' },
      { $group: { _id: '$doctor.state', revenue: { $sum: '$totalFee' } } },
      { $sort: { revenue: -1 } },
      { $limit: 5 },
      { $project: { name: '$_id', revenue: 1, _id: 0 } },
    ]);

    res.json({
      totalPatients,
      totalDoctors,
      totalAppointments,
      completedAppointments,
      canceledAppointments,
      rescheduledAppointments,
      totalRevenue,
      monthlyRevenue,
      monthlyAppointments,
      revenueGrowth,
      refundCancellationTrend,
      totalRefunds,
      paymentModeBreakdown,
      topSpecialties: topSpecialtiesAgg, // Updated key name for consistency
      topEarningDoctors: topEarningDoctorsAgg,
      topRevenueStates: topRevenueStatesAgg,
    });
  } catch (err) {
    console.error('Reports fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get Doctor Statistics
router.get('/doctors/stats', authAdmin, async (req, res) => {
  try {
    const activeDoctors = await Doctor.countDocuments({ accountStatus: 'active' });
    const deactivatedDoctors = await Doctor.countDocuments({ accountStatus: 'deactivated' });
    const deletedDoctors = await Doctor.countDocuments({ accountStatus: 'deleted' });
    res.json({ activeDoctors, deactivatedDoctors, deletedDoctors });
  } catch (err) {
    console.error('Doctor stats fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Appointments Management (updated with new endpoints)
router.get('/appointments/doctor/:doctorId', authAdmin, async (req, res) => {
  try {
    const appointments = await Appointment.find({ doctorId: req.params.doctorId })
      .populate('patientId', 'name');
    res.json(appointments);
  } catch (err) {
    console.error('Doctor appointments fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update Cancel Appointment Endpoint
router.put('/appointments/:id/cancel', authAdmin, async (req, res) => {
  try {
    const { reason } = req.body;
    console.log(`Cancel request for appointment ${req.params.id} with reason: ${reason}`);

    if (!reason) {
      console.log('Missing cancellation reason');
      return res.status(400).json({ error: 'Cancellation reason required' });
    }

    const appointment = await Appointment.findById(req.params.id)
      .populate('patientId', 'name email')
      .populate('doctorId', 'name')
      .catch(err => {
        throw new Error(`Database error finding appointment: ${err.message}`);
      });

    if (!appointment) {
      console.log(`Appointment ${req.params.id} not found`);
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (appointment.status === 'canceled') {
      console.log(`Appointment ${req.params.id} already canceled`);
      return res.status(400).json({ error: 'Appointment already canceled' });
    }

    console.log(`Updating appointment ${req.params.id} to canceled`);
    appointment.status = 'canceled';
    appointment.cancellationReason = reason;
    appointment.canceledAt = new Date();

    // If paid, mark refund as pending but don’t change paymentStatus yet
    if (appointment.paymentStatus === 'paid') {
      appointment.refundStatus = 'Pending';
      console.log(`Marked refund as pending for appointment ${appointment._id}`);
    }

    await appointment.save().catch(err => {
      throw new Error(`Database error saving appointment: ${err.message}`);
    });

    // Send email to patient
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('SMTP credentials missing; skipping email');
    } else {
      const mailOptions = {
        from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
        to: appointment.patientId.email,
        subject: 'Appointment Cancellation - TrueMedicine',
        html: `
          <h2>Hello ${appointment.patientId.name},</h2>
          <p>Your appointment with Dr. ${appointment.doctorId.name} has been canceled by the admin.</p>
          <p><strong>Date:</strong> ${new Date(appointment.date).toLocaleString()}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          ${
            appointment.paymentStatus === 'paid'
              ? '<p>Your refund is being processed and will be credited within 5-7 working days.</p>'
              : ''
          }
          <p>For any queries, contact support@truemedicine.com.</p>
          <p>Best regards,<br>The TrueMedicine Team</p>
        `,
      };
      await transporter.sendMail(mailOptions).catch(err => {
        console.error(`Email sending failed: ${err.message}`);
        throw new Error(`Failed to send cancellation email: ${err.message}`);
      });
      console.log(`Cancellation email sent to ${appointment.patientId.email}`);
    }

    // Send notification to patient
    const patient = await Patient.findById(appointment.patientId._id).catch(err => {
      throw new Error(`Database error finding patient: ${err.message}`);
    });
    patient.notificationHistory = patient.notificationHistory || [];
    patient.notificationHistory.push({
      date: new Date(),
      message: `Your appointment with Dr. ${appointment.doctorId.name} on ${new Date(appointment.date).toLocaleString()} has been canceled. Reason: ${reason}`,
    });
    await patient.save().catch(err => {
      throw new Error(`Database error saving patient notification: ${err.message}`);
    });
    console.log(`Notification added to patient ${patient._id}`);

    res.json(appointment);
  } catch (err) {
    console.error(`Appointment cancel error for ${req.params.id}: ${err.message}`, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Update Reschedule Appointment Endpoint
// routes/admin.js
router.put('/appointments/:id/reschedule', authAdmin, async (req, res) => {
  try {
    const { newDate, reason } = req.body;
    console.log(`Reschedule request for appointment ${req.params.id} to ${newDate} with reason: ${reason}`);

    if (!newDate || !reason) {
      console.log('Missing newDate or reason');
      return res.status(400).json({ error: 'New date and reason required' });
    }

    const appointment = await Appointment.findById(req.params.id)
      .populate('patientId', 'name email')
      .populate('doctorId', 'name')
      .catch(err => {
        throw new Error(`Database error finding appointment: ${err.message}`);
      });

    if (!appointment) {
      console.log(`Appointment ${req.params.id} not found`);
      return res.status(404).json({ error: 'Appointment not found' });
    }
    if (appointment.status === 'canceled') {
      console.log(`Appointment ${req.params.id} is canceled and cannot be rescheduled`);
      return res.status(400).json({ error: 'Cannot reschedule a canceled appointment' });
    }

    console.log(`Updating appointment ${req.params.id} to rescheduled`);
    const oldDate = appointment.date; // Preserve original date
    appointment.rescheduledDate = new Date(newDate); // Set new rescheduled date
    appointment.status = 'rescheduled';
    appointment.rescheduleReason = reason;
    await appointment.save().catch(err => {
      throw new Error(`Database error saving appointment: ${err.message}`);
    });

    // Send email to patient
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      console.warn('SMTP credentials missing; skipping email');
    } else {
      const mailOptions = {
        from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
        to: appointment.patientId.email,
        subject: 'Appointment Rescheduled - TrueMedicine',
        html: `
          <h2>Hello ${appointment.patientId.name},</h2>
          <p>Your appointment with Dr. ${appointment.doctorId.name} has been rescheduled by the admin.</p>
          <p><strong>Original Date:</strong> ${new Date(oldDate).toLocaleString()}</p>
          <p><strong>New Date:</strong> ${new Date(appointment.rescheduledDate).toLocaleString()}</p>
          <p><strong>Reason:</strong> ${reason}</p>
          <p>For any queries, contact support@truemedicine.com.</p>
          <p>Best regards,<br>The TrueMedicine Team</p>
        `,
      };
      await transporter.sendMail(mailOptions).catch(err => {
        console.error(`Email sending failed: ${err.message}`);
        throw new Error(`Failed to send reschedule email: ${err.message}`);
      });
      console.log(`Reschedule email sent to ${appointment.patientId.email}`);
    }

    // Send notification to patient
    const patient = await Patient.findById(appointment.patientId._id).catch(err => {
      throw new Error(`Database error finding patient: ${err.message}`);
    });
    patient.notificationHistory = patient.notificationHistory || [];
    patient.notificationHistory.push({
      date: new Date(),
      message: `Your appointment with Dr. ${appointment.doctorId.name} has been rescheduled from ${new Date(oldDate).toLocaleString()} to ${new Date(appointment.rescheduledDate).toLocaleString()}. Reason: ${reason}`,
    });
    await patient.save().catch(err => {
      throw new Error(`Database error saving patient notification: ${err.message}`);
    });
    console.log(`Notification added to patient ${patient._id}`);

    res.json(appointment);
  } catch (err) {
    console.error(`Appointment reschedule error for ${req.params.id}: ${err.message}`, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Patient-specific endpoints

// Process Refund with Razorpay Integration


router.post('/notifications/:patientId', authAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });
    const patient = await Patient.findById(req.params.patientId);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    patient.notificationHistory = patient.notificationHistory || [];
    patient.notificationHistory.push({ date: new Date(), message });
    await patient.save();
    res.json({ message: 'Notification sent' });
  } catch (err) {
    console.error('Notification error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/users/:id/reset-password', authAdmin, async (req, res) => {
  try {
    const patient = await Patient.findById(req.params.id);
    if (!patient) return res.status(404).json({ error: 'Patient not found' });
    res.json({ message: 'Password reset link sent' });
  } catch (err) {
    console.error('Reset password error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get appointment details with doctor name populated


// Get prescription details by appointment ID
router.get('/prescriptions/appointment/:appointmentId', authAdmin, async (req, res) => {
  try {
    const prescription = await Prescription.findOne({ appointmentId: req.params.appointmentId });
    if (!prescription) return res.status(404).json({ error: 'Prescription not found' });
    res.json(prescription);
  } catch (err) {
    console.error('Fetch prescription error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Update appointment status and notes
// Get Appointment Details (Ensure refund details are included)
router.get('/appointments/:appointmentId', authAdmin, async (req, res) => {
  try {
    const appointment = await Appointment.findById(req.params.appointmentId)
      .populate('patientId', 'name email')
      .populate('doctorId', 'name');
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // Ensure paymentDetails is populated if paid or refunded
    let paymentDetails = appointment.paymentDetails || {};
    if (
      ['paid', 'refunded'].includes(appointment.paymentStatus) &&
      (!paymentDetails.paymentId || !paymentDetails.amountPaid || !paymentDetails.paidAt)
    ) {
      try {
        const payment = await razorpay.payments.fetch(paymentDetails.paymentId || appointment.transactionId);
        paymentDetails = {
          paymentId: payment.id,
          amountPaid: payment.amount / 100,
          status: payment.status === 'captured' ? 'paid' : payment.status,
          method: payment.method || 'Unknown',
          transactionId: payment.id,
          paidAt: new Date(payment.created_at * 1000).toISOString(),
          invoicePath: paymentDetails.invoicePath || null,
        };
        await Appointment.updateOne(
          { _id: appointment._id },
          { $set: { paymentDetails } }
        );
      } catch (error) {
        console.error(`Failed to fetch payment details: ${error.message}`);
        paymentDetails = {
          paymentId: paymentDetails.paymentId || 'N/A',
          amountPaid: appointment.totalFee || 0,
          status: appointment.paymentStatus || 'paid',
          method: paymentDetails.method || 'Unknown',
          transactionId: paymentDetails.transactionId || 'N/A',
          paidAt: paymentDetails.paidAt || appointment.createdAt || new Date().toISOString(),
          invoicePath: paymentDetails.invoicePath || null,
        };
        await Appointment.updateOne(
          { _id: appointment._id },
          { $set: { paymentDetails } }
        );
      }
    }

    const appointmentWithDetails = {
      ...appointment.toObject(),
      doctorName: appointment.doctorId?.name || 'Unknown',
      patientName: appointment.patientId?.name || 'Unknown',
      paymentDetails,
    };
    res.json(appointmentWithDetails);
  } catch (err) {
    console.error('Fetch appointment error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Add this route after other prescription-related routes
router.get('/prescriptions/download/:prescriptionId', authAdmin, async (req, res) => {
  try {
    const { prescriptionId } = req.params;

    // Find the prescription
    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ error: 'Prescription not found' });
    }

    const filePath = prescription.pdfPath;
    if (!filePath) {
      return res.status(404).json({ error: 'PDF not found for this prescription' });
    }

    // Authorize with B2 if not already done
    if (!b2BucketId) {
      await b2.authorize();
      const bucketResponse = await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME });
      b2BucketId = bucketResponse.data.buckets[0].bucketId;
    }

    // Get download authorization
    const { data: auth } = await b2.getDownloadAuthorization({
      bucketId: b2BucketId,
      fileNamePrefix: filePath.replace(`${process.env.B2_BUCKET_NAME}/`, ''),
      validDurationInSeconds: 3600, // URL valid for 1 hour
    });

    // Construct the direct download URL
    const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${filePath.replace(`${process.env.B2_BUCKET_NAME}/`, '')}?Authorization=${auth.authorizationToken}`;

    // Return the URL
    res.json({ url: downloadUrl });
  } catch (err) {
    console.error('Prescription download error:', {
      message: err.message,
      stack: err.stack,
    });
    res.status(500).json({
      error: 'Failed to fetch prescription download URL',
      details: err.message,
    });
  }
});

// Process refund
// Process Refund (Updated)
// Process Refund with Razorpay Integration
// Inside server/routes/admin.js
router.post('/payments/refund/:appointmentId', authAdmin, async (req, res) => {
  try {
    const { refundAmount } = req.body;
    if (!refundAmount || isNaN(refundAmount) || refundAmount <= 0) {
      return res.status(400).json({ error: 'Valid refund amount is required' });
    }

    const appointment = await Appointment.findById(req.params.appointmentId)
      .populate('patientId', 'name email')
      .populate('doctorId', 'name');
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (appointment.status !== 'canceled') {
      return res.status(400).json({ error: 'Refund can only be processed for canceled appointments' });
    }
    if (appointment.paymentStatus !== 'paid') {
      return res.status(400).json({ error: 'No payment to refund' });
    }
    if (appointment.refundStatus === 'Processed') {
      return res.status(400).json({ error: 'Refund already processed' });
    }

    const totalFee = appointment.totalFee || 0;
    const cancellationFee = 50;
    const maxRefundableAmount = Math.max(totalFee - cancellationFee, 0);
    if (refundAmount > maxRefundableAmount) {
      return res.status(400).json({ error: `Refund amount exceeds maximum refundable amount of ₹${maxRefundableAmount} (Total Fee: ₹${totalFee} - ₹${cancellationFee} Cancellation Fee)` });
    }

    const gatewayFee = totalFee * 0.02; // 2% Razorpay fee
    const gstOnGatewayFee = gatewayFee * 0.18; // 18% GST
    const amountAfterGateway = totalFee - (gatewayFee + gstOnGatewayFee);
    const restAfterRefund = amountAfterGateway - refundAmount;

    let refund = null;
    const paymentId = appointment.paymentDetails?.paymentId;
    if (!paymentId) {
      console.warn(`No paymentId found for appointment ${appointment._id}; processing as manual refund`);
    } else if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.warn('Razorpay credentials not configured; processing as manual refund');
    } else {
      try {
        const payment = await razorpay.payments.fetch(paymentId);
        console.log(`Payment details for ${paymentId}:`, {
          status: payment.status,
          amount: payment.amount / 100,
          amount_refunded: payment.amount_refunded / 100,
          captured: payment.captured,
        });

        if (payment.status !== 'captured' && payment.captured !== true) {
          return res.status(400).json({
            error: 'Payment not eligible for refund',
            details: `Status: ${payment.status}, Captured: ${payment.captured}`,
          });
        }
        if (payment.amount_refunded >= payment.amount) {
          console.warn(`Payment ${paymentId} already fully refunded in Razorpay`);
          if (appointment.paymentStatus !== 'refunded' || appointment.refundStatus !== 'Processed') {
            appointment.paymentStatus = 'refunded';
            appointment.refundStatus = 'Processed';
            appointment.refundedAt = new Date();
            appointment.refundDetails = {
              refundId: `RAZORPAY-${paymentId}-ALREADY-REFUNDED`,
              amount: payment.amount_refunded / 100,
              status: 'Processed',
              createdAt: new Date(),
              cancellationFee,
              gatewayFee,
              gstOnGatewayFee,
              restAfterRefund,
            };
            await appointment.save();
            console.log(`Appointment ${appointment._id} updated to reflect existing refund`);
          }
          return res.json({
            message: 'Refund already processed in Razorpay',
            appointment: { ...appointment._doc, doctorName: appointment.doctorId?.name || 'Unknown' },
            refundDetails: appointment.refundDetails,
          });
        }

        refund = await razorpay.payments.refund(paymentId, {
          amount: Math.round(refundAmount * 100), // Convert to paise
          speed: 'normal',
          notes: {
            reason: 'Appointment canceled by patient/admin with ₹50 cancellation fee',
            appointmentId: appointment._id.toString(),
            cancellationFee,
            gatewayFee,
            gstOnGatewayFee,
            restAfterRefund,
          },
        });
        console.log(`Razorpay refund successful for ${paymentId}:`, refund);
      } catch (razorpayErr) {
        console.error('Razorpay refund error:', razorpayErr.message, razorpayErr.stack);
        throw new Error(`Razorpay refund failed: ${razorpayErr.message}`);
      }
    }

    // Update appointment with refund details
    appointment.paymentStatus = 'refunded';
    appointment.refundStatus = 'Processed';
    appointment.refundedAt = new Date();
    appointment.refundDetails = refund
      ? {
          refundId: refund.id,
          amount: refund.amount / 100,
          status: refund.status,
          createdAt: new Date(refund.created_at * 1000),
          cancellationFee,
          gatewayFee,
          gstOnGatewayFee,
          restAfterRefund,
        }
      : {
          refundId: `MANUAL-${Date.now()}`,
          amount: refundAmount,
          status: 'Processed',
          createdAt: new Date(),
          cancellationFee,
          gatewayFee,
          gstOnGatewayFee,
          restAfterRefund,
        };
    await appointment.save();
    console.log(`Appointment ${appointment._id} updated with refund details`);

    // Send refund confirmation email
    const mailOptions = {
      from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
      to: appointment.patientId.email,
      subject: 'TrueMedicine: Refund Processed',
      html: `
        <div style="font-family: Arial, sans-serif; color: #333;">
          <h2 style="color: #2ecc71;">Refund Processed Successfully!</h2>
          <p>Dear ${appointment.patientId.name},</p>
          <p>Your refund for the appointment with Dr. ${appointment.doctorId?.name || 'Unknown'} has been processed.</p>
          <h3>Appointment Details</h3>
          <p>Appointment ID: ${appointment._id}</p>
          <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
          <p>Total Amount Paid: ₹${totalFee}</p>
          <p>Cancellation Fee: ₹${cancellationFee}</p>
          <p>Refunded Amount: ₹${appointment.refundDetails.amount}</p>
          <p>Refund ID: ${appointment.refundDetails.refundId}</p>
          <p><strong>Note:</strong> The amount will be credited to your original payment method within 5-7 working days.</p>
          <p>If you have any questions, contact us at support@truemedicine.com.</p>
          <p>Best regards,<br/>The TrueMedicine Team</p>
        </div>
      `,
    };
    await transporter.sendMail(mailOptions);
    console.log(`Refund email sent to ${appointment.patientId.email}`);

    res.json({
      message: 'Refund processed successfully',
      appointment: { ...appointment._doc, doctorName: appointment.doctorId?.name || 'Unknown' },
      refundDetails: appointment.refundDetails,
    });
  } catch (err) {
    console.error('Refund processing error:', err.message, err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Get feedback by patient ID
router.get('/feedback/patient/:patientId', authAdmin, async (req, res) => {
  try {
    const feedbacks = await Feedback.find({ patientId: req.params.patientId });
    const feedbacksWithDoctor = await Promise.all(feedbacks.map(async (fb) => {
      const doctor = await Doctor.findById(fb.doctorId);
      return {
        ...fb._doc,
        doctorName: doctor ? doctor.name : 'Unknown'
      };
    }));
    res.json(feedbacksWithDoctor);
  } catch (err) {
    console.error('Fetch feedback error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Delete feedback
router.delete('/feedback/:feedbackId', authAdmin, async (req, res) => {
  try {
    const feedback = await Feedback.findByIdAndDelete(req.params.feedbackId);
    if (!feedback) return res.status(404).json({ error: 'Feedback not found' });
    res.json({ message: 'Feedback deleted successfully' });
  } catch (err) {
    console.error('Delete feedback error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Get all medical records for a patient
router.get('/medical-records/patient/:patientId', authAdmin, async (req, res) => {
  try {
    const records = await MedicalRecord.find({ patientId: req.params.patientId });
    res.json(records);
  } catch (err) {
    console.error('Fetch medical records error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Get patient appointment history (prescriptions) with doctor names
router.get('/appointments/patient/:patientId/history', authAdmin, async (req, res) => {
  try {
    const prescriptions = await Prescription.find({ patientId: req.params.patientId });
    const prescriptionsWithDoctor = await Promise.all(prescriptions.map(async (pres) => {
      const doctor = await Doctor.findById(pres.doctorId);
      return {
        ...pres._doc,
        doctorName: doctor ? doctor.name : 'Unknown Doctor'
      };
    }));
    res.json({ prescriptions: prescriptionsWithDoctor });
  } catch (err) {
    console.error('Fetch history error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});



// Get Platform Settings
// Get Platform Settings
// Get Platform Settings
router.get('/platform-settings', authAdmin, async (req, res) => {
  try {
    let settings = await PlatformSettings.findOne();
    if (!settings) {
      settings = new PlatformSettings(); // Default values: 30% patient, 10% doctor
      await settings.save();
    }
    res.json({
      patientCommission: settings.patientCommission,
      doctorCommission: settings.doctorCommission,
    });
  } catch (err) {
    console.error('Settings fetch error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update Platform Settings
router.put('/platform-settings', authAdmin, async (req, res) => {
  try {
    const { patientCommission, doctorCommission } = req.body;
    if (typeof patientCommission !== 'number' || typeof doctorCommission !== 'number' || patientCommission < 0 || doctorCommission < 0) {
      return res.status(400).json({ error: 'Invalid commission rates' });
    }
    let settings = await PlatformSettings.findOne();
    if (!settings) {
      settings = new PlatformSettings();
    }
    settings.patientCommission = patientCommission;
    settings.doctorCommission = doctorCommission;
    settings.updatedAt = new Date();
    await settings.save();
    res.json({ message: 'Settings updated', settings });
  } catch (err) {
    console.error('Settings update error:', err.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin Earnings & Payments Overview
// Admin Earnings & Payments Overview
// Admin Earnings & Payments Overview
router.get('/earnings-payments', authAdmin, async (req, res) => {
  try {
    const { startDate, endDate, state, city } = req.query;

    // Build the base query for appointments
    let query = { status: 'completed' };

    // Add date filters if provided
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    // Fetch doctor IDs based on state and city filters
    let doctorFilter = {};
    if (state) doctorFilter.state = state;
    if (city) doctorFilter.city = city;

    // If state or city is provided, filter appointments by doctor IDs
    if (state || city) {
      const doctorIds = (await Doctor.find(doctorFilter).select('_id')).map(doc => doc._id);
      if (doctorIds.length === 0) {
        // If no doctors match the state/city, return empty results
        return res.json({
          breakdown: [],
          totalRevenueAllTime: 0,
          totalPlatformEarningsAllTime: 0,
          patientCommissionAllTime: 0,
          doctorCommissionAllTime: 0,
          completedAppointmentsAllTime: 0,
          totalRevenueToday: 0,
          totalPlatformEarningsToday: 0,
          patientCommissionToday: 0,
          doctorCommissionToday: 0,
          completedAppointmentsToday: 0,
        });
      }
      query.doctorId = { $in: doctorIds };
    }

    // Fetch appointments with populated doctor details
    const appointments = await Appointment.find(query)
      .populate('doctorId', 'name state city');

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Helper function to check if a date is today
    const isToday = (date) => {
      if (!date) return false;
      const compareDate = new Date(date);
      compareDate.setHours(0, 0, 0, 0);
      return compareDate.toDateString() === today.toDateString();
    };

    // Process all appointments to build the breakdown
    const doctorEarningsMap = appointments.reduce((map, app) => {
      const doctorId = app.doctorId?._id.toString();
      if (!doctorId) return map;

      const baseFee = app.consultationFee || 0;
      const patientCommissionRate = app.patientCommissionRate / 100 || 0;
      const doctorCommissionRate = app.doctorCommissionRate / 100 || 0;
      const patientCommission = baseFee * patientCommissionRate;
      const doctorCommission = baseFee * doctorCommissionRate;
      const totalPaid = baseFee + patientCommission; // Revenue from patient
      const finalDoctorEarning = baseFee - doctorCommission; // Doctor's net earnings
      const platformEarning = patientCommission + doctorCommission; // Platform's commission

      if (!map[doctorId]) {
        map[doctorId] = {
          doctorId,
          doctorName: app.doctorId?.name || 'Unknown',
          state: app.doctorId?.state || 'N/A',
          city: app.doctorId?.city || 'N/A',
          totalPaid: 0,
          doctorFee: 0,
          patientCommission: 0,
          doctorCommission: 0,
          finalDoctorEarning: 0,
          platformEarning: 0,
          appointmentIds: [],
          date: app.completedAt || app.date,
        };
      }

      map[doctorId].totalPaid += totalPaid;
      map[doctorId].doctorFee += baseFee;
      map[doctorId].patientCommission += patientCommission;
      map[doctorId].doctorCommission += doctorCommission;
      map[doctorId].finalDoctorEarning += finalDoctorEarning;
      map[doctorId].platformEarning += platformEarning;
      map[doctorId].appointmentIds.push(app._id);
      return map;
    }, {});

    const breakdown = Object.values(doctorEarningsMap);

    // Calculate totals for all time
    const totalRevenueAllTime = breakdown.reduce((sum, item) => sum + item.totalPaid, 0);
    const totalPlatformEarningsAllTime = breakdown.reduce((sum, item) => sum + item.platformEarning, 0);
    const patientCommissionAllTime = breakdown.reduce((sum, item) => sum + item.patientCommission, 0);
    const doctorCommissionAllTime = breakdown.reduce((sum, item) => sum + item.doctorCommission, 0);
    const completedAppointmentsAllTime = appointments.length;

    // Filter for today's completed appointments
    const todayAppointments = appointments.filter(app => isToday(app.completedAt));
    const todayBreakdown = todayAppointments.reduce((map, app) => {
      const doctorId = app.doctorId?._id.toString();
      if (!doctorId) return map;

      const baseFee = app.consultationFee || 0;
      const patientCommissionRate = app.patientCommissionRate / 100 || 0;
      const doctorCommissionRate = app.doctorCommissionRate / 100 || 0;
      const patientCommission = baseFee * patientCommissionRate;
      const doctorCommission = baseFee * doctorCommissionRate;
      const totalPaid = baseFee + patientCommission;
      const finalDoctorEarning = baseFee - doctorCommission;
      const platformEarning = patientCommission + doctorCommission;

      if (!map[doctorId]) {
        map[doctorId] = {
          doctorId,
          doctorName: app.doctorId?.name || 'Unknown',
          state: app.doctorId?.state || 'N/A',
          city: app.doctorId?.city || 'N/A',
          totalPaid: 0,
          doctorFee: 0,
          patientCommission: 0,
          doctorCommission: 0,
          finalDoctorEarning: 0,
          platformEarning: 0,
          appointmentIds: [],
          date: app.completedAt || app.date,
        };
      }

      map[doctorId].totalPaid += totalPaid;
      map[doctorId].doctorFee += baseFee;
      map[doctorId].patientCommission += patientCommission;
      map[doctorId].doctorCommission += doctorCommission;
      map[doctorId].finalDoctorEarning += finalDoctorEarning;
      map[doctorId].platformEarning += platformEarning;
      map[doctorId].appointmentIds.push(app._id);
      return map;
    }, {});

    const todayBreakdownArray = Object.values(todayBreakdown);

    // Calculate totals for today
    const totalRevenueToday = todayBreakdownArray.reduce((sum, item) => sum + item.totalPaid, 0);
    const totalPlatformEarningsToday = todayBreakdownArray.reduce((sum, item) => sum + item.platformEarning, 0);
    const patientCommissionToday = todayBreakdownArray.reduce((sum, item) => sum + item.patientCommission, 0);
    const doctorCommissionToday = todayBreakdownArray.reduce((sum, item) => sum + item.doctorCommission, 0);
    const completedAppointmentsToday = todayAppointments.length;

    res.json({
      breakdown, // Full breakdown for filtering on frontend
      totalRevenueAllTime,
      totalPlatformEarningsAllTime,
      patientCommissionAllTime,
      doctorCommissionAllTime,
      completedAppointmentsAllTime,
      totalRevenueToday,
      totalPlatformEarningsToday,
      patientCommissionToday,
      doctorCommissionToday,
      completedAppointmentsToday,
    });
  } catch (err) {
    console.error('Earnings fetch error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});


// Bulk Approve Withdrawals
router.post('/withdrawals/bulk-approve', authAdmin, async (req, res) => {
  try {
    const { withdrawalIds } = req.body;
    if (!Array.isArray(withdrawalIds) || !withdrawalIds.length) {
      return res.status(400).json({ error: 'No withdrawal IDs provided' });
    }

    const withdrawals = await Withdrawal.find({ _id: { $in: withdrawalIds }, status: 'pending' }).populate('doctorId', 'email name');
    if (!withdrawals.length) return res.status(404).json({ error: 'No pending withdrawals found' });

    await Promise.all(withdrawals.map(async w => {
      w.status = 'approved';
      await w.save();
      await transporter.sendMail({
        from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
        to: w.doctorId.email,
        subject: 'Withdrawal Approved - TrueMedicine',
        html: `<h2>Hello Dr. ${w.doctorId.name},</h2><p>Your withdrawal request of ₹${w.amount} has been approved and processed.</p><p>Best regards,<br>The TrueMedicine Team</p>`,
      });
    }));

    res.json({ message: 'Bulk payout processed', count: withdrawals.length });
  } catch (err) {
    console.error('Bulk approve error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Add this to your admin.js routes
// backend/routes/admin.js (Updated /financial-report endpoint)
// Updated Endpoint: Financial Report
// ... (existing imports remain unchanged)

router.get('/financial-report', authAdmin, async (req, res) => {
  try {
    const { startDate, endDate, doctorId, status, state, city } = req.query;
    const query = {};

    if (startDate && endDate) {
      query.$or = [
        { createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) } },
        { completedAt: { $gte: new Date(startDate), $lte: new Date(endDate) } },
      ];
    }
    if (doctorId) query.doctorId = doctorId;
    if (status) {
      if (status === 'refunded') query.paymentStatus = 'refunded';
      else query.status = status;
    }

    const appointments = await Appointment.find(query)
      .populate('patientId', 'name')
      .populate({
        path: 'doctorId',
        select: 'name state city consultationFee',
        match: { ...(state && { state }), ...(city && { city }) },
      });

    const filteredAppointments = appointments.filter(app => app.doctorId !== null);

    // Financial Metrics
    let deferredRevenue = 0;
    let grossRevenue = 0;
    let refundedAmount = 0;
    let netRevenue = 0;
    let doctorEarningsBeforeFees = 0;
    let platformCommissionFromPatients = 0;
    let platformDeductionFromDoctors = 0;
    let doctorPayouts = 0;
    let totalAppointments = 0;
    let completedAppointments = 0;
    let canceledAppointments = 0;
    let totalTransactions = 0;
    let gstCollected = 0;
    let paymentGatewayFees = 0;
    let gstOnPaymentGatewayFees = 0;
    let restAmountAfterRefund = 0;

    const revenueBreakdownByStatus = {
      pending: { count: 0, amount: 0 },
      accepted: { count: 0, amount: 0 },
      rescheduled: { count: 0, amount: 0 },
      rejected: { count: 0, amount: 0 },
      completed: { count: 0, amount: 0 },
      canceled: { count: 0, amount: 0 },
    };

    const doctorEarningsMap = {};
    const refundReport = [];
    const monthlyRevenue = {};
    const dailyRevenue = {};
    const patientTransactions = [];
    const transactionBreakdown = { successful: 0, refunded: 0, pending: 0, failed: 0 };

    filteredAppointments.forEach((app) => {
      const totalFee = app.totalFee || 0;
      const doctorFee = app.consultationFee || 0;
      const patientCommissionRate = app.patientCommissionRate / 100 || 0.1; // Default 10%
      const doctorCommissionRate = app.doctorCommissionRate / 100 || 0.2; // Default 20%
      const platformFeeFromPatient = doctorFee * patientCommissionRate;
      const platformDeductionFromDoctor = doctorFee * doctorCommissionRate;
      const netDoctorPayout = doctorFee - platformDeductionFromDoctor;
      const gstRate = 0.18; // Example GST rate

      const doctorIdStr = app.doctorId?._id?.toString();
      const bookingDate = new Date(app.createdAt);
      const completionDate = app.completedAt ? new Date(app.completedAt) : null;
      const appointmentDate = new Date(app.date);
      const today = new Date();
      const isBookedInPeriod = startDate && endDate ? bookingDate >= new Date(startDate) && bookingDate <= new Date(endDate) : true;
      const isCompletedInPeriod = completionDate && startDate && endDate ? completionDate >= new Date(startDate) && completionDate <= new Date(endDate) : false;

      // Daily Revenue
      const dayKey = formatDate(bookingDate);
      dailyRevenue[dayKey] = dailyRevenue[dayKey] || {
        date: dayKey,
        grossRevenue: 0,
        deferredRevenue: 0,
        netRevenue: 0,
        refundedAmount: 0,
        doctorPayouts: 0,
      };

      if (isBookedInPeriod) {
        totalAppointments++;
        totalTransactions++; // Counting appointments as transactions
        if (doctorIdStr && app.doctorId?.name) {
          doctorEarningsMap[doctorIdStr] = doctorEarningsMap[doctorIdStr] || {
            doctorName: app.doctorId.name,
            earningsBeforeFees: 0,
            platformDeduction: 0,
            netPayout: 0,
            pendingPayout: 0,
            totalAppointments: 0,
            completedAppointments: 0,
            state: app.doctorId.state || 'N/A',
            city: app.doctorId.city || 'N/A',
          };
          doctorEarningsMap[doctorIdStr].totalAppointments++;
        }

        // Patient Transactions with actual refund amount
        const actualRefundAmount = app.paymentStatus === 'refunded' && app.refundDetails?.amount
          ? app.refundDetails.amount
          : app.paymentStatus === 'refunded'
          ? Math.max(totalFee - 50, 0) // Fallback: totalFee - cancellationFee
          : 0;

        patientTransactions.push({
          patientName: app.patientId?.name || 'Unknown',
          appointmentId: app._id,
          totalPaid: totalFee,
          amount: app.paymentStatus === 'refunded' ? actualRefundAmount : totalFee,
          status: app.paymentStatus === 'paid' ? 'successful' : app.paymentStatus === 'refunded' ? 'refunded' : 'pending',
          date: app.paymentDetails?.paidAt || app.createdAt,
        });

        if (app.paymentStatus === 'paid') transactionBreakdown.successful++;
        else if (app.paymentStatus === 'refunded') transactionBreakdown.refunded++;
        else if (app.paymentStatus === 'pending') transactionBreakdown.pending++;
        else transactionBreakdown.failed++;
      }

      if (app.status === 'completed' && isCompletedInPeriod) {
        completedAppointments++;
        grossRevenue += totalFee;
        doctorEarningsBeforeFees += doctorFee;
        platformCommissionFromPatients += platformFeeFromPatient;
        platformDeductionFromDoctors += platformDeductionFromDoctor;
        doctorPayouts += netDoctorPayout;
        revenueBreakdownByStatus.completed.count++;
        revenueBreakdownByStatus.completed.amount += totalFee;
        dailyRevenue[dayKey].grossRevenue += totalFee;
        dailyRevenue[dayKey].netRevenue += (totalFee - netDoctorPayout);
        dailyRevenue[dayKey].doctorPayouts += netDoctorPayout;

        if (doctorIdStr && isBookedInPeriod) {
          doctorEarningsMap[doctorIdStr].earningsBeforeFees += doctorFee;
          doctorEarningsMap[doctorIdStr].platformDeduction += platformDeductionFromDoctor;
          doctorEarningsMap[doctorIdStr].netPayout += netDoctorPayout;
          doctorEarningsMap[doctorIdStr].completedAppointments++;
        }
      } else if (['pending', 'accepted', 'rescheduled', 'rejected'].includes(app.status) && isBookedInPeriod && appointmentDate > today) {
        deferredRevenue += totalFee;
        revenueBreakdownByStatus[app.status].count++;
        revenueBreakdownByStatus[app.status].amount += totalFee;
        dailyRevenue[dayKey].deferredRevenue += totalFee;
      } else if (app.status === 'canceled' && isBookedInPeriod) {
        canceledAppointments++;
        revenueBreakdownByStatus.canceled.count++;
        revenueBreakdownByStatus.canceled.amount += totalFee;
        dailyRevenue[dayKey].canceledAppointments = (dailyRevenue[dayKey].canceledAppointments || 0) + 1;

        if (app.paymentStatus === 'refunded') {
          const refundAmount = app.refundDetails?.amount || Math.max(totalFee - 50, 0);
          refundedAmount += refundAmount;
          const gatewayFee = totalFee * 0.02; // 2% Razorpay fee
          const gstOnGatewayFee = gatewayFee * 0.18; // 18% GST
          const amountAfterGateway = totalFee - (gatewayFee + gstOnGatewayFee);
          const restAfterRefund = amountAfterGateway - refundAmount;
          restAmountAfterRefund += restAfterRefund;

          refundReport.push({
            patientName: app.patientId?.name || 'Unknown',
            appointmentId: app._id,
            totalPaid: totalFee,
            refundAmount: refundAmount,
            cancellationFee: app.refundDetails?.cancellationFee || 50,
            status: 'Completed',
            dateOfRefund: app.refundedAt,
          });
          dailyRevenue[dayKey].refundedAmount += refundAmount;
          paymentGatewayFees += gatewayFee;
          gstOnPaymentGatewayFees += gstOnGatewayFee;
        } else if (app.paymentStatus === 'paid') {
          refundReport.push({
            patientName: app.patientId?.name || 'Unknown',
            appointmentId: app._id,
            totalPaid: totalFee,
            refundAmount: Math.max(totalFee - 50, 0),
            cancellationFee: 50,
            status: 'Pending',
            dateOfRefund: null,
          });
        }
      }

      if (isBookedInPeriod) {
        const bookingMonth = bookingDate.toLocaleString('default', { month: 'short', year: 'numeric' });
        monthlyRevenue[bookingMonth] = monthlyRevenue[bookingMonth] || {
          month: bookingMonth,
          grossRevenue: 0,
          refundedAmount: 0,
          doctorPayouts: 0,
          totalAppointments: 0,
          completedAppointments: 0,
          canceledAppointments: 0,
        };
        monthlyRevenue[bookingMonth].totalAppointments++;
        if (app.status === 'completed' && isCompletedInPeriod) {
          monthlyRevenue[bookingMonth].grossRevenue += totalFee;
          monthlyRevenue[bookingMonth].doctorPayouts += netDoctorPayout;
          monthlyRevenue[bookingMonth].completedAppointments++;
        } else if (app.status === 'canceled' && app.paymentStatus === 'refunded') {
          monthlyRevenue[bookingMonth].refundedAmount += app.refundDetails?.amount || Math.max(totalFee - 50, 0);
          monthlyRevenue[bookingMonth].canceledAppointments++;
        } else if (app.status === 'canceled') {
          monthlyRevenue[bookingMonth].canceledAppointments++;
        }
      }
    });

    // Net Revenue and GST Calculation
    netRevenue = platformCommissionFromPatients + platformDeductionFromDoctors; // Platform's earnings
    gstCollected = netRevenue * 0.18; // GST on Net Revenue
    const arpa = completedAppointments > 0 ? grossRevenue / completedAppointments : 0;

    const doctorEarnings = await Promise.all(
      Object.entries(doctorEarningsMap).map(async ([doctorId, data]) => {
        const withdrawals = await Withdrawal.find({ doctorId, status: 'approved' });
        const totalWithdrawn = withdrawals.reduce((sum, w) => sum + (w.approvedAmount || w.amount), 0);
        const pendingPayout = data.netPayout - totalWithdrawn;
        return {
          doctorId,
          doctorName: data.doctorName,
          earningsBeforeFees: data.earningsBeforeFees,
          platformDeduction: data.platformDeduction,
          netPayout: data.netPayout,
          pendingPayout: pendingPayout > 0 ? pendingPayout : 0,
          totalAppointments: data.totalAppointments,
          completedAppointments: data.completedAppointments,
          state: data.state,
          city: data.city,
        };
      })
    );

    const totalPendingPayouts = doctorEarnings.reduce((sum, doc) => sum + doc.pendingPayout, 0);
    const totalPendingRefunds = refundReport
      .filter((r) => r.status === 'Pending')
      .reduce((sum, r) => sum + r.refundAmount, 0);

    // Platform Financial Calculations
    const platformTotalRevenue = platformCommissionFromPatients + platformDeductionFromDoctors;
    const netPlatformProfit = platformTotalRevenue - (paymentGatewayFees + gstOnPaymentGatewayFees) + restAmountAfterRefund;

    // Simple Revenue Forecast
    const last30DaysRevenue = dailyRevenue[Object.keys(dailyRevenue).sort().slice(-1)[0]]?.grossRevenue || 0;
    const forecast = [];
    for (let i = 1; i <= 30; i++) {
      const date = new Date();
      date.setDate(date.getDate() + i);
      forecast.push({
        date: formatDate(date),
        predictedRevenue: last30DaysRevenue * (1 + i * 0.01), // 1% daily growth assumption
      });
    }

    res.json({
      deferredRevenue,
      grossRevenue,
      refundedAmount,
      netRevenue,
      doctorEarningsBeforeFees,
      platformCommissionFromPatients,
      platformDeductionFromDoctors,
      doctorPayouts,
      totalAppointments,
      completedAppointments,
      canceledAppointments,
      revenueBreakdownByStatus,
      doctorEarnings,
      refundReport,
      monthlyRevenue: Object.values(monthlyRevenue),
      dailyRevenue: Object.values(dailyRevenue),
      totalPendingPayouts,
      totalPendingRefunds,
      totalTransactions,
      transactionBreakdown,
      arpa,
      patientTransactions,
      commissionBreakdown: {
        patientCommission: platformCommissionFromPatients,
        doctorDeduction: platformDeductionFromDoctors,
      },
      gstCollected,
      revenueForecast: forecast,
      platformTotalRevenue,
      paymentGatewayFees,
      gstOnPaymentGatewayFees,
      netPlatformProfit,
      restAmountAfterRefund,
    });
  } catch (err) {
    console.error('Financial report error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// ... (rest of the existing routes remain unchanged)

// New Endpoint: Schedule Financial Report
router.post('/schedule-financial-report', authAdmin, async (req, res) => {
  try {
    const { frequency } = req.body;
    if (!['weekly', 'monthly'].includes(frequency)) {
      return res.status(400).json({ error: 'Invalid frequency. Use "weekly" or "monthly"' });
    }

    const config = { headers: { Authorization: `Bearer ${req.admin.accessToken}` } };
    const adminEmail = process.env.ADMIN_EMAIL || req.admin.email; // Ensure ADMIN_EMAIL is set in environment variables

    const generateReport = async () => {
      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const endOfMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      const response = await api.get('/admin/financial-report', {
        ...config,
        params: { startDate: startOfMonth, endDate: endOfMonth },
      });
      const financialData = response.data;

      const doc = new PDFDocument();
      const invoicePath = path.join(invoiceDir, `scheduled_report_${Date.now()}.pdf`);
      const stream = fs.createWriteStream(invoicePath);
      doc.pipe(stream);

      doc.fontSize(20).text('TrueMedicine Financial Report', { align: 'center' });
      doc.fontSize(14).text(`Period: ${startOfMonth.toLocaleDateString()} to ${endOfMonth.toLocaleDateString()}`, { align: 'center' });
      doc.moveDown();
      doc.fontSize(12).text(`Total Revenue: ₹${financialData.totalRevenue.toLocaleString()}`);
      doc.text(`Net Revenue: ₹${financialData.netRevenue.toLocaleString()}`);
      doc.text(`Total Payouts: ₹${financialData.totalPayouts.toLocaleString()}`);
      doc.text(`Total Refunds: ₹${financialData.totalRefunds.toLocaleString()}`);
      doc.text(`Pending Refunds: ₹${financialData.pendingRefunds.toLocaleString()}`);
      doc.text(`Total Pending Payouts: ₹${financialData.totalPendingPayouts.toLocaleString()}`);
      doc.end();

      await new Promise(resolve => stream.on('finish', resolve));

      await transporter.sendMail({
        from: `"TrueMedicine" <${process.env.EMAIL_USER}>`,
        to: adminEmail,
        subject: `Scheduled Financial Report - ${frequency}`,
        html: `
          <h2>Scheduled Financial Report</h2>
          <p>Please find the attached financial report for the period ${startOfMonth.toLocaleDateString()} to ${endOfMonth.toLocaleDateString()}.</p>
          <p>Best regards,<br>The TrueMedicine Team</p>
        `,
        attachments: [{ filename: `financial_report_${Date.now()}.pdf`, path: invoicePath }],
      });
    };

    const cronSchedule = frequency === 'weekly' ? '0 0 * * 1' : '0 0 1 * *'; // Weekly on Monday at midnight, Monthly on 1st at midnight
    const task = cron.schedule(cronSchedule, generateReport);
    scheduledReports.set(req.admin.id, task);

    res.json({ message: 'Financial report scheduled successfully' });
  } catch (err) {
    console.error('Schedule report error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;