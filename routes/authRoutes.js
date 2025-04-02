const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Patient = require('../models/Patient');
const Doctor = require('../models/Doctor');
const nodemailer = require('nodemailer'); // This line must be here
const multer = require('multer');
const path = require('path');
const B2 = require('backblaze-b2'); // Add Backblaze B2
const fs = require('fs'); // Add this line with other requires

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

// Backblaze B2 Configuration
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});
let b2BucketId = null;

const authorizeB2 = async () => {
  const { data } = await b2.authorize();
  b2BucketId = (await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME })).data.buckets[0].bucketId;
};

const uploadFileToB2 = async (file, doctorId) => {
  try {
    if (!b2BucketId) await authorizeB2();
    
    const filePath = path.resolve(file.path);
    const fileData = fs.readFileSync(filePath);
    const fileName = `doctors/${doctorId}/${Date.now()}-${file.originalname}`;

    // Get upload URL
    const { data: uploadUrlData } = await b2.getUploadUrl({ 
      bucketId: b2BucketId 
    });

    // Upload file
    const { data: uploadedFile } = await b2.uploadFile({
      uploadUrl: uploadUrlData.uploadUrl,
      uploadAuthToken: uploadUrlData.authorizationToken,
      fileName,
      data: fileData,
      contentType: file.mimetype,
    });

    // Clean up local file
    fs.unlinkSync(filePath);
    
    // Return the full file path in B2
    return `${process.env.B2_BUCKET_NAME}/${fileName}`;
    
  } catch (error) {
    console.error('Error uploading to Backblaze B2:', error);
    throw new Error(`File upload failed: ${error.message}`);
  }
};

// Secrets
const PATIENT_ACCESS_TOKEN_SECRET = process.env.PATIENT_ACCESS_TOKEN_SECRET || 'patient_access_secret';
const DOCTOR_ACCESS_TOKEN_SECRET = process.env.DOCTOR_ACCESS_TOKEN_SECRET || 'doctor_access_secret';
const REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'your_refresh_token_secret';
const RESET_TOKEN_SECRET = process.env.RESET_TOKEN_SECRET || 'your_reset_token_secret'; // Ensure this line exists


// Nodemailer configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Patient Signup
// Patient Signup
// Patient Signup
router.post('/patient/signup', async (req, res) => {
  console.log('Received signup request at /auth/patient/signup:', req.body);
  try {
    const { name, email, password, age, gender, phone, address } = req.body;
    console.log('Destructured data:', { name, email, age, gender, phone, address });

    if (!name || !email || !password || !age || !gender) {
      console.log('Missing required fields:', { name, email, password, age, gender });
      return res.status(400).json({ error: 'Name, email, password, age, and gender are required' });
    }

    const parsedAge = parseInt(age);
    if (isNaN(parsedAge) || parsedAge < 1 || parsedAge > 150) {
      console.log('Invalid age:', age);
      return res.status(400).json({ error: 'Age must be a number between 1 and 150' });
    }

    const existingPatient = await Patient.findOne({ email });
    if (existingPatient) {
      console.log('Duplicate email found:', email);
      return res.status(400).json({ error: 'Patient with this email already exists' });
    }

    // Create patient without hashing password manually (let the pre-save hook handle it)
    const newPatient = new Patient({ 
      name, 
      email, 
      password, // Pass plain password here
      age: parsedAge, 
      gender,
      phone: phone || '', 
      address: address || '' 
    });

    // Save patient (pre-save hook will hash the password)
    await newPatient.save();
    console.log('Patient saved with ID:', newPatient._id);

    const accessToken = jwt.sign(
      { id: newPatient._id, role: 'patient' },
      PATIENT_ACCESS_TOKEN_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { id: newPatient._id, role: 'patient' },
      REFRESH_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    newPatient.refreshToken = refreshToken;
    await newPatient.save(); // Save again to store refreshToken
    console.log('Refresh token saved');

    res.status(201).json({
      message: 'Patient registered successfully',
      token: accessToken,
      patientId: newPatient._id,
      refreshToken,
      role: 'patient'
    });
  } catch (error) {
    console.error('Error in patient signup:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Doctor Registration (updated for B2 upload)
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

      console.log('Received registration data:', { email: emailLower });

      // Validation checks
      if (!name || !email || !phone || !specialization || !state || !city || !experience || !address || !password) {
        return res.status(400).json({ error: 'All fields are required' });
      }

      if (!req.files?.medicalLicense?.[0] || !req.files?.degreeCertificate?.[0] || !req.files?.idProof?.[0]) {
        return res.status(400).json({ error: 'All documents are required' });
      }

      const existingDoctor = await Doctor.findOne({ email: emailLower });
      if (existingDoctor) {
        console.log('Duplicate doctor found:', emailLower);
        return res.status(400).json({ error: 'Doctor with this email already exists' });
      }

      // Create doctor with empty documents first
      const doctor = new Doctor({
        name,
        email: emailLower,
        phone,
        specialization,
        state,
        city,
        experience: parseInt(experience),
        address,
        password, // Will be hashed by pre-save hook
        isVerified: false,
        documents: {
          medicalLicense: 'temp', // Temporary values to pass validation
          degreeCertificate: 'temp',
          idProof: 'temp'
        }
      });

      // Save doctor to get _id
      await doctor.save();
      console.log('Doctor saved with ID:', doctor._id);

      // Upload files to Backblaze B2
      const [medicalLicensePath, degreeCertificatePath, idProofPath] = await Promise.all([
        uploadFileToB2(req.files.medicalLicense[0], doctor._id),
        uploadFileToB2(req.files.degreeCertificate[0], doctor._id),
        uploadFileToB2(req.files.idProof[0], doctor._id)
      ]);

      // Update doctor with actual document paths
      doctor.documents = {
        medicalLicense: medicalLicensePath,
        degreeCertificate: degreeCertificatePath,
        idProof: idProofPath,
      };
      
      // Save again with actual document paths
      await doctor.save();
      console.log('Documents uploaded to B2:', doctor.documents);

      // Generate tokens
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
      res.status(500).json({ 
        error: 'Server error', 
        details: error.message,
        validationErrors: error.errors // Include validation errors if any
      });
    }
  }
);

// Patient Login
router.post('/patient/login', async (req, res) => {
  console.log('Received login request:', req.body); // Debug log
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      console.log('Missing email or password'); // Debug log
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const patient = await Patient.findOne({ email });
    if (!patient) {
      console.log('Patient not found:', email); // Debug log
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await patient.matchPassword(password);
    console.log('Password match result:', isMatch); // Debug log
    if (!isMatch) {
      console.log('Password mismatch for:', email); // Debug log
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const accessToken = jwt.sign(
      { id: patient._id, role: 'patient' },
      PATIENT_ACCESS_TOKEN_SECRET,
      { expiresIn: '15m' }
    );
    const refreshToken = jwt.sign(
      { id: patient._id, role: 'patient' },
      REFRESH_TOKEN_SECRET,
      { expiresIn: '7d' }
    );

    await Patient.updateOne({ _id: patient._id }, { $set: { refreshToken } });
    console.log('Login successful for:', email); // Debug log
    res.json({
      message: 'Login successful',
      patientId: patient._id,
      role: 'patient',
      accessToken,
      refreshToken,
    });
  } catch (error) {
    console.error('Error in patient login:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
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
  const { refreshToken, role } = req.body;
  if (!refreshToken || !role) {
    return res.status(400).json({ error: 'Refresh token and role are required' });
  }

  try {
    // Verify the refresh token
    const decoded = jwt.verify(refreshToken, REFRESH_TOKEN_SECRET);
    if (decoded.role !== role) {
      return res.status(403).json({ error: 'Role mismatch in refresh token' });
    }

    // Find the user based on role and ID
    const user = decoded.role === 'patient'
      ? await Patient.findById(decoded.id)
      : await Doctor.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if the stored refresh token matches the provided one
    if (user.refreshToken !== refreshToken) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    // Determine the access token secret based on role
    const accessTokenSecret = decoded.role === 'patient'
      ? PATIENT_ACCESS_TOKEN_SECRET
      : DOCTOR_ACCESS_TOKEN_SECRET;

    // Generate a new access token with fresh timestamps
    const newAccessToken = jwt.sign(
      { id: user._id, role: decoded.role },
      accessTokenSecret,
      { expiresIn: '15m' } // Fresh 15-minute expiration
    );

    res.json({
      message: 'Token refreshed successfully',
      accessToken: newAccessToken,
      role: decoded.role,
    });
  } catch (error) {
    console.error('Error refreshing token:', error.stack);
    res.status(401).json({ error: 'Invalid or expired refresh token', details: error.message });
  }
});

// Logout
router.post('/logout', async (req, res) => {
  const { role, userId } = req.body;
  try {
    if (!role || !userId) {
      return res.status(400).json({ error: 'Role and user ID are required' });
    }

    const Model = role === 'patient' ? Patient : Doctor;
    await Model.updateOne({ _id: userId }, { $unset: { refreshToken: 1 } });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Error in logout:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});


// Patient Forgot Password
router.post('/patient/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const patient = await Patient.findOne({ email });
    if (!patient) return res.status(404).json({ error: 'Patient not found' });

    const resetToken = jwt.sign({ id: patient._id, role: 'patient' }, RESET_TOKEN_SECRET, { expiresIn: '15m' });
    patient.resetToken = resetToken;
    await patient.save();

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/patient/${resetToken}`;
    const mailOptions = {
      from: `"TureMedicine" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request',
      text: `Click the following link to reset your password: ${resetUrl}\nThis link will expire in 15 minutes.`,
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'Password reset link sent to your email.' });
  } catch (error) {
    console.error('Error in patient forgot password:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Doctor Forgot Password
router.post('/doctor/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const doctor = await Doctor.findOne({ email });
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const resetToken = jwt.sign({ id: doctor._id, role: 'doctor' }, RESET_TOKEN_SECRET, { expiresIn: '15m' });
    doctor.resetToken = resetToken;
    await doctor.save();

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/doctor/${resetToken}`;
    const mailOptions = {
      from: `"TureMedicine" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Request',
      text: `Click the following link to reset your password: ${resetUrl}\nThis link will expire in 15 minutes.`,
    };

    await transporter.sendMail(mailOptions);
    res.json({ message: 'Password reset link sent to your email.' });
  } catch (error) {
    console.error('Error in doctor forgot password:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

// Patient Reset Password
router.post('/patient/reset-password', async (req, res) => {
  const { token, password } = req.body;
  try {
    const decoded = jwt.verify(token, RESET_TOKEN_SECRET);
    if (decoded.role !== 'patient') {
      return res.status(403).json({ error: 'Invalid token role' });
    }

    const patient = await Patient.findOne({ _id: decoded.id, resetToken: token });
    if (!patient) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    patient.password = password; // Set plaintext password; pre-save hook will hash it
    patient.resetToken = undefined; // Clear the reset token
    await patient.save();

    console.log('Password updated for patient:', patient.email); // Debug log
    res.json({ message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Error in patient reset password:', error.stack);
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});

// Doctor Reset Password
router.post('/doctor/reset-password', async (req, res) => {
  const { token, password } = req.body;
  try {
    const decoded = jwt.verify(token, RESET_TOKEN_SECRET);
    if (decoded.role !== 'doctor') {
      return res.status(403).json({ error: 'Invalid token role' });
    }

    const doctor = await Doctor.findOne({ _id: decoded.id, resetToken: token });
    if (!doctor) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    doctor.password = password; // Set plaintext password; pre-save hook will hash it
    doctor.resetToken = undefined; // Clear the reset token
    await doctor.save();

    console.log('Password updated for doctor:', doctor.email); // Debug log
    res.json({ message: 'Password reset successfully.' });
  } catch (error) {
    console.error('Error in doctor reset password:', error.stack);
    res.status(400).json({ error: 'Invalid or expired token' });
  }
});


module.exports = router;