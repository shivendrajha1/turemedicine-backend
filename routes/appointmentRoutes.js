const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');
const Prescription = require('../models/Prescription');
const Notification = require('../models/Notification');
const Doctor = require('../models/Doctor');
const Patient = require('../models/Patient');
const PlatformSettings = require('../models/PlatformSettings');
const { auth, authDoctor, authPatient } = require('../middlewares/authMiddleware');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const B2 = require('backblaze-b2'); // Added Backblaze B2
const axios = require('axios'); // Add this at the top of appointments.js

require('dotenv').config();

// Razorpay Configuration
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Nodemailer Configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Multer Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});
const upload = multer({ storage });

// Initialize Backblaze B2
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

let b2BucketId = null;
let b2DownloadUrl = null;

async function authorizeB2() {
  try {
    const authResponse = await b2.authorize();
    b2DownloadUrl = authResponse.data.downloadUrl;
    const bucketsResponse = await b2.listBuckets();
    const bucket = bucketsResponse.data.buckets.find(b => b.bucketName === process.env.B2_BUCKET_NAME);
    if (!bucket) throw new Error(`Bucket ${process.env.B2_BUCKET_NAME} not found`);
    b2BucketId = bucket.bucketId;
    console.log('Backblaze B2 authorized successfully:', { bucketId: b2BucketId, downloadUrl: b2DownloadUrl });
  } catch (error) {
    console.error('Error authorizing Backblaze B2:', error);
    throw error;
  }
}
authorizeB2().catch(err => console.error('Initial B2 authorization failed:', err));

// Upload Single File to Backblaze B2 (for booking PDF)
const uploadToB2 = async (filePath, fileName) => {
  if (!b2BucketId) await authorizeB2();
  try {
    const fileData = fs.readFileSync(filePath);
    const { data: uploadUrlData } = await b2.getUploadUrl({ bucketId: b2BucketId });
    const { data: uploadedFile } = await b2.uploadFile({
      uploadUrl: uploadUrlData.uploadUrl,
      uploadAuthToken: uploadUrlData.authorizationToken,
      fileName,
      data: fileData,
      contentType: 'application/pdf',
    });
    fs.unlinkSync(filePath);
    return {
      fileId: uploadedFile.fileId,
      fileName: uploadedFile.fileName,
      path: uploadedFile.fileName,
    };
  } catch (error) {
    console.error('Error uploading to B2:', error.stack);
    throw error;
  }
};

// Upload Prescription PDF to Backblaze B2
const uploadPrescriptionToB2 = async (appointmentId, filePath, fileName) => {
  if (!b2BucketId) await authorizeB2();
  try {
    const b2FileName = `appointments/${appointmentId}/${fileName}`;
    const fileData = fs.readFileSync(filePath);
    const { data: uploadUrlData } = await b2.getUploadUrl({ bucketId: b2BucketId });
    const { data: uploadedFile } = await b2.uploadFile({
      uploadUrl: uploadUrlData.uploadUrl,
      uploadAuthToken: uploadUrlData.authorizationToken,
      fileName: b2FileName,
      data: fileData,
      contentType: 'application/pdf',
    });
    fs.unlinkSync(filePath);
    return {
      fileId: uploadedFile.fileId,
      fileName: uploadedFile.fileName,
      path: b2FileName,
    };
  } catch (error) {
    console.error('Error uploading prescription to B2:', error.stack);
    throw error;
  }
};

// Function to generate a modern PDF (unchanged)
// Updated: Generate Modern Booking PDF with Graphics and Branding
// Generate Booking PDF
// Generate Booking PDF
const generateBookingPDF = (appointment, patient, doctor, paymentDetails) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const pdfPath = path.join(__dirname, `../uploads/booking_${appointment._id}.pdf`);
    const stream = fs.createWriteStream(pdfPath);

    doc.pipe(stream);

    doc.rect(0, 0, doc.page.width, 120).fill('#3498db');
    doc.rect(0, 0, doc.page.width, 60).fill('#2980b9');
    const logoPath = path.join(__dirname, '../assets/turemedicine-logo.png');
    if (fs.existsSync(logoPath)) {
      doc.image(logoPath, 40, 20, { width: 80 });
    } else {
      doc.fontSize(25).fillColor('#ffffff').text('TureMedicine', 40, 35);
    }
    doc.fontSize(16).fillColor('#ffffff').text('Appointment Booking Confirmation', 150, 70, { align: 'center' });
    doc.fontSize(10).fillColor('#ecf0f1').text('Your Telehealth Partner', 150, 95, { align: 'center' });

    doc.rect(40, 140, doc.page.width - 80, 400).fillAndStroke('#ffffff', '#bdc3c7').fill('#ffffff');

    doc.fontSize(14).fillColor('#2c3e50').text('Patient Details', 50, 150);
    doc.fontSize(11).fillColor('#34495e')
      .text(`Name: ${patient.name}`, 50, 170)
      .text(`Age: ${appointment.age}`, 50, 185)
      .text(`Gender: ${appointment.gender}`, 50, 200)
      .text(`Email: ${patient.email}`, 50, 215);

    doc.fontSize(14).fillColor('#2c3e50').text('Doctor Details', 300, 150);
    doc.fontSize(11).fillColor('#34495e')
      .text(`Name: Dr. ${doctor.name}`, 300, 170)
      .text(`Specialization: ${doctor.specialization || 'N/A'}`, 300, 185)
      .text(`Contact: ${doctor.phone || 'N/A'}`, 300, 200);

    doc.fontSize(14).fillColor('#2c3e50').text('Appointment Details', 50, 240);
    doc.fontSize(11).fillColor('#34495e')
      .text(`Date: ${new Date(appointment.date).toLocaleString()}`, 50, 260)
      .text(`Symptoms: ${appointment.symptoms || 'Not provided'}`, 50, 275)
      .text(`Status: ${appointment.bookingStatus}`, 50, 290);

    doc.fontSize(14).fillColor('#2c3e50').text('Payment Details', 50, 320);
    doc.fontSize(11).fillColor('#34495e')
      .text(`Consultation Fee: ₹${appointment.consultationFee}`, 50, 340)
      .text(`Total Fee: ₹${appointment.totalFee}`, 50, 355)
      .text(`Payment Status: ${appointment.paymentStatus}`, 50, 370)
      .text(`Transaction ID: ${paymentDetails.paymentId || 'N/A'}`, 50, 385)
      .text(`Paid At: ${paymentDetails.paidAt ? new Date(paymentDetails.paidAt).toLocaleString() : 'N/A'}`, 50, 400);

    doc.fontSize(10).fillColor('#e74c3c').text(
      'Note: We will inform you when the doctor accepts or rejects your appointment.',
      50, 430, { align: 'center', width: doc.page.width - 100 }
    );

    doc.rect(0, doc.page.height - 60, doc.page.width, 60).fill('#3498db');
    doc.fontSize(10).fillColor('#ffffff')
      .text('TureMedicine - A Telehealth Care Platform', 50, doc.page.height - 45, { align: 'center' })
      .text('Contact Us:turemedicine@gmail.com | www.turemedicine.com', 50, doc.page.height - 30, { align: 'center' });

    doc.circle(580, 50, 20).fill('#ecf0f1');
    doc.circle(560, 70, 15).fill('#bdc3c7');

    doc.end();

    stream.on('finish', () => resolve(pdfPath));
    stream.on('error', (err) => reject(err));
  });
};

// Send Booking Email
// Updated Send Booking Email
const sendBookingEmail = async (patient, doctor, appointment, paymentDetails) => {
  const pdfPath = await generateBookingPDF(appointment, patient, doctor, paymentDetails);
  const fileName = `booking_appointmentpdf/booking_${appointment._id}.pdf`;

  try {
    // Send email with the local PDF file before uploading to B2
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: patient.email,
      subject: 'TureMedicine: Appointment Booking Confirmation',
      html: `
        <div style="font-family: Arial, sans-serif; color: #333;">
          <h2 style="color: #3498db;">Appointment Booked Successfully!</h2>
          <p>Dear ${patient.name},</p>
          <p>Your appointment with Dr. ${doctor.name} has been successfully booked. Below are the details:</p>
          <h3>Patient Details</h3>
          <p>Name: ${patient.name}</p>
          <p>Age: ${appointment.age}</p>
          <p>Gender: ${appointment.gender}</p>
          <h3>Doctor Details</h3>
          <p>Name: Dr. ${doctor.name}</p>
          <p>Specialization: ${doctor.specialization || 'N/A'}</p>
          <h3>Appointment Details</h3>
          <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
          <p>Symptoms: ${appointment.symptoms || 'Not provided'}</p>
          <h3>Payment Details</h3>
          <p>Consultation Fee: ₹${appointment.consultationFee}</p>
          <p>Total Fee: ₹${appointment.totalFee}</p>
          <p>Payment Status: ${appointment.paymentStatus}</p>
          <p>Transaction ID: ${paymentDetails.paymentId || 'N/A'}</p>
          <p>Paid At: ${paymentDetails.paidAt ? new Date(paymentDetails.paidAt).toLocaleString() : 'N/A'}</p>
          <p style="color: #e74c3c;"><strong>Note:</strong> We will inform you when Dr. ${doctor.name} accepts or rejects your appointment.</p>
          <p>Your booking confirmation is attached below.</p>
          <p>Best regards,<br/>The TureMedicine Team</p>
        </div>
      `,
      attachments: [
        {
          filename: `Booking_Confirmation_${appointment._id}.pdf`,
          path: pdfPath,
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log(`Booking email sent successfully to ${patient.email}`);

    // Upload to Backblaze B2 after sending the email
    const uploadedFile = await uploadToB2(pdfPath, fileName);
    const downloadUrl = `${b2DownloadUrl}/file/${process.env.B2_BUCKET_NAME}/${uploadedFile.path}`;
    console.log(`Booking PDF uploaded to B2: ${downloadUrl}`);

    // Clean up the local file after both email and upload are complete
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
  } catch (error) {
    console.error('Error in sendBookingEmail:', error.stack);
    // Clean up the file in case of an error
    if (fs.existsSync(pdfPath)) {
      fs.unlinkSync(pdfPath);
    }
    throw error; // Re-throw to be caught by the caller
  }
};

// Send Doctor Appointment Email
const sendDoctorAppointmentEmail = async (patient, doctor, appointment) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: doctor.email,
    subject: 'TureMedicine: New Appointment Request',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #3498db;">New Appointment Request</h2>
        <p>Dear Dr. ${doctor.name},</p>
        <p>A new appointment has been booked by ${patient.name}.</p>
        <h3>Patient Details</h3>
        <p>Name: ${patient.name}</p>
        <p>Age: ${appointment.age}</p>
        <p>Gender: ${appointment.gender}</p>
        <h3>Appointment Details</h3>
        <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p>Symptoms: ${appointment.symptoms || 'Not provided'}</p>
        <p>Please log in to your dashboard to accept or reject this appointment.</p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };
  await transporter.sendMail(mailOptions);
};

// Function to send status update email (unchanged)
const sendStatusUpdateEmail = async (patient, doctor, appointment, status) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: patient.email,
    subject: `TureMedicine: Appointment ${status === 'accepted' ? 'Accepted' : 'Rejected'}`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: ${status === 'accepted' ? '#2ecc71' : '#e74c3c'};">Appointment ${status === 'accepted' ? 'Accepted' : 'Rejected'}</h2>
        <p>Dear ${patient.name},</p>
        <p>Your appointment with Dr. ${doctor.name} has been ${status}.</p>
        <h3>Appointment Details</h3>
        <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p>Status: ${appointment.status}</p>
        <p>Thank you for using TureMedicine.</p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

// New: Send email when appointment is completed
const sendCompletionEmail = async (patient, doctor, appointment) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: patient.email,
    subject: 'TureMedicine: Appointment Completed',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2ecc71;">Appointment Completed!</h2>
        <p>Dear ${patient.name},</p>
        <p>Your appointment with Dr. ${doctor.name} has been successfully completed.</p>
        <h3>Appointment Details</h3>
        <p>Appointment ID: ${appointment._id}</p>
        <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p>Completed At: ${new Date(appointment.completedAt).toLocaleString()}</p>
        <p>Call Duration: ${appointment.callDuration || 'N/A'}</p>
        <p style="color: #3498db;"><strong>Note:</strong> Your prescription will be sent shortly by Dr. ${doctor.name}.</p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

// Updated: Send email when prescription is generated (uses B2 URL instead of attachment)
// Updated Send Prescription Email with Attachment
const sendPrescriptionEmail = async (patient, doctor, appointment, prescription) => {
  let attachments = [];
  let tempPdfPath = null;

  try {
    const fileName = prescription.pdfPath;
    const downloadUrl = `${b2DownloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}`;

    if (fileName && prescription.fileId) {
      // Download the file from Backblaze B2
      tempPdfPath = path.join(__dirname, `../uploads/prescription_${prescription._id}.pdf`);
      const { data: fileStream } = await b2.downloadFileById({
        fileId: prescription.fileId,
        responseType: 'stream',
      });

      const writer = fs.createWriteStream(tempPdfPath);
      fileStream.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      attachments.push({
        filename: `Prescription_${prescription._id}.pdf`,
        path: tempPdfPath,
      });
    } else {
      console.warn('No fileId or pdfPath available for attachment');
    }

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: patient.email,
      subject: 'TureMedicine: Your Prescription is Ready',
      html: `
        <div style="font-family: Arial, sans-serif; color: #333;">
          <h2 style="color: #2ecc71;">Prescription Generated!</h2>
          <p>Dear ${patient.name},</p>
          <p>Your prescription from Dr. ${doctor.name} for your recent appointment has been generated.</p>
          <h3>Appointment Details</h3>
          <p>Appointment ID: ${appointment._id}</p>
          <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
          <h3>Prescription Details</h3>
          <p>Medications: ${prescription.medications.map(m => `${m.name} (${m.dosage})`).join(', ') || 'N/A'}</p>
          <p>Instructions: ${prescription.instructions || 'N/A'}</p>
          <p>Next Appointment: ${prescription.nextAppointmentDate ? new Date(prescription.nextAppointmentDate).toLocaleString() : 'N/A'}</p>
          <p>Download your prescription here: <a href="${downloadUrl}">Prescription PDF</a></p>
          ${attachments.length > 0 ? '<p>Please find your prescription PDF attached to this email.</p>' : '<p>Note: The prescription file could not be attached. Please use the download link above.</p>'}
          <p>Best regards,<br/>The TureMedicine Team</p>
        </div>
      `,
      attachments,
    };

    await transporter.sendMail(mailOptions);
    console.log(`Prescription email sent successfully to ${patient.email}`);
  } catch (error) {
    console.error('Error sending prescription email:', error.stack);
    throw error;
  } finally {
    // Cleanup temporary file
    if (tempPdfPath && fs.existsSync(tempPdfPath)) {
      fs.unlinkSync(tempPdfPath);
    }
  }
};

// New: Send email when appointment is rescheduled
const sendRescheduleEmail = async (patient, doctor, appointment, reason) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: patient.email,
    subject: 'TureMedicine: Appointment Rescheduled',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #f1c40f;">Appointment Rescheduled</h2>
        <p>Dear ${patient.name},</p>
        <p>Your appointment with Dr. ${doctor.name} has been rescheduled.</p>
        <h3>Appointment Details</h3>
        <p>Appointment ID: ${appointment._id}</p>
        <p>Original Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p>New Date: ${new Date(appointment.rescheduledDate).toLocaleString()}</p>
        <p>Reason: ${reason}</p>
        <p>We apologize for any inconvenience caused.</p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

// New Endpoint: Fetch Platform Settings
router.get('/platform-settings', auth, async (req, res) => {
  try {
    let settings = await PlatformSettings.findOne();
    if (!settings) {
      settings = new PlatformSettings({ patientCommission: 30, doctorCommission: 10 });
      await settings.save();
    }
    res.json({
      patientCommission: settings.patientCommission,
      doctorCommission: settings.doctorCommission,
    });
  } catch (error) {
    console.error('Error fetching platform settings:', error.stack);
    res.status(500).json({ error: 'Failed to fetch platform settings', details: error.message });
  }
});

// Book Appointment (Updated with Notification and Doctor Email)
router.post('/book', auth, async (req, res) => {
  try {
    const { patientId, name, age, gender, doctorId, date, symptoms, consultationFee, totalFee, transactionId } = req.body;
    console.log('Received /book request:', { patientId, doctorId, transactionId });

    if (!name || !age || !gender || !doctorId || !date || !consultationFee || !totalFee || !transactionId) {
      return res.status(400).json({ error: 'Missing required fields, including transactionId' });
    }

    if (isNaN(age) || age < 1 || age > 120) {
      return res.status(400).json({ error: 'Invalid age' });
    }
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ error: 'Invalid doctorId' });
    }
    if (isNaN(consultationFee) || consultationFee < 0 || isNaN(totalFee) || totalFee < 0) {
      return res.status(400).json({ error: 'Invalid consultationFee or totalFee' });
    }
    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ error: 'Invalid date format' });
    }

    if (req.user.id !== patientId) {
      return res.status(403).json({ error: 'Unauthorized: Can only book for self' });
    }

    let settings = await PlatformSettings.findOne();
    if (!settings) {
      console.warn('No PlatformSettings found, creating default settings');
      settings = new PlatformSettings({ patientCommission: 30, doctorCommission: 10 });
      await settings.save();
    }
    const patientCommissionRate = settings.patientCommission;
    const doctorCommissionRate = settings.doctorCommission;

    const appointment = new Appointment({
      patientId,
      name,
      age,
      gender,
      doctorId,
      date: parsedDate,
      symptoms,
      consultationFee,
      totalFee,
      status: 'pending',
      paymentStatus: 'paid',
      bookingStatus: 'booked',
      patientCommissionRate,
      doctorCommissionRate,
      paymentDetails: {
        paymentId: transactionId,
        paidAt: new Date(),
      },
    });

    await appointment.save();
    console.log('Appointment booked:', appointment);

    const patient = await Patient.findById(patientId);
    const doctor = await Doctor.findById(doctorId);

    if (!patient || !doctor) {
      return res.status(500).json({ error: 'Patient or doctor not found' });
    }

    await Notification.create({
      recipient: patientId,
      recipientModel: 'Patient',
      message: `Your appointment has been booked with Dr. ${doctor.name}. We will inform you when the appointment is accepted by the doctor.`,
      doctorId,
      appointmentId: appointment._id,
    });

    await sendBookingEmail(patient, doctor, appointment, appointment.paymentDetails);
    await sendDoctorAppointmentEmail(patient, doctor, appointment);

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully',
      appointment,
    });
  } catch (error) {
    console.error('Error booking appointment:', error.stack);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});


// Create Razorpay Order with Enhanced Logging
router.post('/create-order', authPatient, async (req, res) => {
  try {
    const { appointmentId, amount } = req.body;
    console.log('Received /create-order request:', { appointmentId, amount, userId: req.user.id });

    if (!amount || isNaN(amount) || amount <= 0) {
      console.log('Validation failed: Invalid or missing amount');
      return res.status(400).json({ error: 'Invalid or missing amount' });
    }

    const cleanAmount = Number(amount.toFixed(2));
    console.log('Processed amount:', cleanAmount);

    if (appointmentId && !mongoose.Types.ObjectId.isValid(appointmentId)) {
      console.log('Validation failed: Invalid appointmentId');
      return res.status(400).json({ error: 'Invalid appointmentId' });
    }

    if (appointmentId) {
      const appointment = await Appointment.findById(appointmentId);
      if (!appointment || appointment.patientId.toString() !== req.user.id) {
        console.log('Authorization failed:', { appointmentExists: !!appointment, patientIdMatch: appointment?.patientId.toString() === req.user.id });
        return res.status(403).json({ error: 'Unauthorized or appointment not found' });
      }
    }

    const options = {
      amount: Math.round(cleanAmount * 100),
      currency: 'INR',
      receipt: appointmentId ? `appointment_${appointmentId}` : `order_${Date.now()}`,
    };
    console.log('Razorpay options:', options);

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      console.error('Razorpay credentials missing');
      return res.status(500).json({ error: 'Server configuration error: Razorpay credentials missing' });
    }

    const order = await razorpay.orders.create(options);
    console.log('Razorpay order created:', order);

    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error('Error creating Razorpay order:', {
      message: error.message,
      stack: error.stack,
      razorpayError: error.response ? error.response.data : 'No additional Razorpay error details',
    });
    res.status(500).json({ error: 'Failed to create payment order', details: error.message || 'Unknown error' });
  }
});

// Verify Razorpay Payment (Updated with Notification and Doctor Email)
router.post('/verify-payment', authPatient, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, appointmentId } = req.body;
    console.log('Received /verify-payment request:', { razorpay_order_id, razorpay_payment_id, appointmentId });

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      console.log('Validation failed: Missing payment details');
      return res.status(400).json({ error: 'Missing payment details', success: false });
    }

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      console.log('Signature verification failed');
      return res.status(400).json({ error: 'Invalid payment signature', success: false });
    }

    const paymentDetails = {
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      paidAt: new Date(),
    };

    if (appointmentId) {
      if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
        console.log('Invalid appointmentId:', appointmentId);
        return res.status(400).json({ error: 'Invalid appointmentId', success: false });
      }

      const appointment = await Appointment.findByIdAndUpdate(
        appointmentId,
        {
          paymentStatus: 'paid',
          bookingStatus: 'booked',
          paymentDetails,
        },
        { new: true }
      );

      if (!appointment) {
        console.log('Appointment not found:', appointmentId);
        return res.status(404).json({ error: 'Appointment not found', success: false });
      }

      const doctor = await Doctor.findById(appointment.doctorId);
      const patient = await Patient.findById(appointment.patientId);

      if (!patient || !doctor) {
        console.log('Patient or doctor not found:', { patientExists: !!patient, doctorExists: !!doctor });
        return res.status(500).json({ error: 'Patient or doctor not found', success: false });
      }

      await Notification.create({
        recipient: appointment.patientId,
        recipientModel: 'Patient',
        message: `Your appointment has been booked with Dr. ${doctor.name}. We will inform you when the appointment is accepted by the doctor.`,
        doctorId: appointment.doctorId,
        appointmentId,
      });

      await sendBookingEmail(patient, doctor, appointment, paymentDetails);
      await sendDoctorAppointmentEmail(patient, doctor, appointment);

      return res.json({ success: true, message: 'Payment verified and appointment booked', appointment });
    }

    console.log('Payment verified without appointmentId');
    res.json({
      success: true,
      message: 'Payment verified successfully',
      paymentDetails,
    });
  } catch (error) {
    console.error('Error verifying Razorpay payment:', { message: error.message, stack: error.stack });
    if (req.body.appointmentId && mongoose.Types.ObjectId.isValid(req.body.appointmentId)) {
      await Appointment.findByIdAndUpdate(
        req.body.appointmentId,
        { paymentStatus: 'failed', bookingStatus: 'not_booked' },
        { new: true }
      );
    }
    res.status(500).json({ error: 'Payment verification failed', details: error.message, success: false });
  }
});

// Get patient appointments
router.get("/patient/:patientId", authPatient, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID" });
    }

    if (req.user.id !== patientId) {
      return res.status(403).json({ message: "Unauthorized: You can only view your own appointments" });
    }

    const appointments = await Appointment.find({ patientId })
      .populate("doctorId", "name specialization consultationFee")
      .sort({ date: -1 })
      .select("doctorId name age gender date rescheduledDate status consultationFee totalFee symptoms notes records paymentStatus prescriptionStatus callDuration completedAt patientId");

    if (!appointments || appointments.length === 0) {
      return res.status(404).json({ message: "No appointments found for this patient" });
    }

    res.status(200).json(appointments);
  } catch (error) {
    console.error("Error fetching appointments for patient:", error.stack);
    res.status(500).json({ message: "Internal server error", details: error.message });
  }
});

// Get Patient Records for Doctor
router.get('/patient/:patientId/records', authDoctor, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: 'Invalid patient ID' });
    }

    const appointmentExists = await Appointment.findOne({
      patientId,
      doctorId: req.user.id,
    });
    if (!appointmentExists) {
      return res.status(403).json({
        message: 'Unauthorized: You do not have any appointments with this patient',
      });
    }

    const appointments = await Appointment.find({
      patientId,
      doctorId: req.user.id,
    })
      .populate('doctorId', 'name specialization consultationFee')
      .sort({ date: -1 })
      .select(
        'doctorId name age gender date rescheduledDate status consultationFee totalFee symptoms notes records paymentStatus prescriptionStatus callDuration completedAt patientId'
      );

    const prescriptions = await Prescription.find({
      patientId,
      doctorId: req.user.id,
    })
      .populate('doctorId', 'name')
      .sort({ createdAt: -1 });

    const prescriptionsWithDoctor = prescriptions.map((pres) => ({
      ...pres._doc,
      createdAt: pres.createdAt || new Date(),
      doctorName: pres.doctorId?.name || 'Unknown Doctor',
    }));

    res.status(200).json({
      appointments: appointments.length > 0 ? appointments : [],
      prescriptions: prescriptionsWithDoctor.length > 0 ? prescriptionsWithDoctor : [],
    });
  } catch (error) {
    console.error('Error fetching patient records:', error.stack);
    res.status(500).json({ message: 'Internal server error', details: error.message });
  }
});

// Updated: Get doctor appointments
router.get("/doctor/:doctorId", authDoctor, async (req, res) => {
  try {
    const { doctorId } = req.params;
    console.log('Fetching appointments for doctorId:', doctorId);
    console.log('Authenticated user:', req.user);

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: "Invalid doctor ID" });
    }

    if (req.user.id !== doctorId) {
      return res.status(403).json({ message: "Unauthorized: Doctors can only view their own appointments" });
    }

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      return res.status(404).json({ message: "Doctor not found" });
    }

    // Fetch appointments regardless of verification status
    const appointments = await Appointment.find({ doctorId })
      .populate('patientId', 'name email')
      .sort({ date: -1 })
      .select("patientId name age gender date rescheduledDate symptoms status consultationFee totalFee notes records paymentStatus prescriptionStatus callDuration completedAt");

    // If no appointments exist, return an empty array instead of 404
    const appointmentsWithPrescriptionStatus = await Promise.all(
      appointments.map(async (app) => {
        const prescription = await Prescription.findOne({ appointmentId: app._id });
        return {
          ...app._doc,
          hasPrescription: !!prescription,
        };
      })
    );

    console.log('Appointments sent to frontend:', appointmentsWithPrescriptionStatus);
    res.status(200).json(appointmentsWithPrescriptionStatus);
  } catch (error) {
    console.error("Error fetching appointments for doctor:", error.stack);
    res.status(500).json({ message: "Internal server error", details: error.message });
  }
});

// Accept Appointment
router.put('/:appointmentId/accept', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
    if (appointment.doctorId.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    appointment.status = 'accepted';
    await appointment.save();

    const doctor = await Doctor.findById(appointment.doctorId);
    const patient = await Patient.findById(appointment.patientId);

    await Notification.create({
      recipient: appointment.patientId,
      recipientModel: 'Patient',
      message: `Your appointment is accepted by Dr. ${doctor ? doctor.name : 'Unknown'}`,
      doctorId: appointment.doctorId,
      appointmentId,
    });

    await sendStatusUpdateEmail(patient, doctor, appointment, 'accepted');

    res.status(200).json({ message: 'Appointment accepted successfully', appointment });
  } catch (error) {
    console.error('Error accepting appointment:', error.stack);
    res.status(500).json({ message: 'Failed to accept appointment', error: error.message });
  }
});

// Reject Appointment
router.put('/:appointmentId/reject', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  const { reason } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }

    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      return res.status(400).json({ message: 'Reason for rejection is required' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    if (appointment.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only reject your own appointments' });
    }

    appointment.status = 'rejected';
    appointment.rejectReason = reason.trim();
    await appointment.save();

    const doctor = await Doctor.findById(appointment.doctorId);
    const patient = await Patient.findById(appointment.patientId);

    if (!doctor || !patient) {
      return res.status(500).json({ message: 'Doctor or patient not found' });
    }

    await Notification.create({
      recipient: appointment.patientId,
      recipientModel: 'Patient',
      message: `Your appointment with Dr. ${doctor.name} has been rejected. Reason: ${reason}.`,
      doctorId: appointment.doctorId,
      appointmentId,
    });

    await sendRejectionEmail(patient, doctor, appointment, reason);

    res.status(200).json({ 
      message: 'Appointment rejected successfully', 
      appointment 
    });
  } catch (error) {
    console.error('Error rejecting appointment:', error.stack);
    res.status(500).json({ 
      message: 'Failed to reject appointment', 
      error: error.message 
    });
  }
});

// Supporting function: Send rejection email
const sendRejectionEmail = async (patient, doctor, appointment, reason) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: patient.email,
    subject: 'TureMedicine: Appointment Rejected',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #e74c3c;">Appointment Rejected</h2>
        <p>Dear ${patient.name},</p>
        <p>Your appointment with Dr. ${doctor.name} has been rejected.</p>
        <h3>Appointment Details</h3>
        <p>Appointment ID: ${appointment._id}</p>
        <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p>Reason for Rejection: ${reason}</p>
        <p style="color: #3498db;"><strong>Note:</strong> You can reschedule this appointment by contacting support at <a href="mailto:turemedicine@gmail.com">turemedicine@gmail.com</a>.</p>
        <p>We apologize for any inconvenience caused.</p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};

// Reschedule Appointment
router.put('/:appointmentId/reschedule', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  const { date, reason } = req.body;

  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }

    if (!date || !reason) {
      return res.status(400).json({ message: 'Date and reason are required for rescheduling' });
    }

    const parsedDate = new Date(date);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }

    if (appointment.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    appointment.rescheduledDate = parsedDate;
    appointment.status = 'rescheduled';
    await appointment.save();

    const doctor = await Doctor.findById(appointment.doctorId);
    const patient = await Patient.findById(appointment.patientId);

    await Notification.create({
      recipient: appointment.patientId,
      recipientModel: "Patient",
      message: `Your appointment is rescheduled to ${parsedDate.toLocaleString()} by Dr. ${doctor ? doctor.name : 'Unknown'} due to: ${reason}`,
      doctorId: appointment.doctorId,
      appointmentId,
    });

    await sendRescheduleEmail(patient, doctor, appointment, reason);

    res.json({ 
      message: 'Appointment rescheduled successfully', 
      appointment: {
        ...appointment.toObject(),
        rescheduledDate: appointment.rescheduledDate,
      }
    });
  } catch (error) {
    console.error('Error rescheduling appointment:', error.stack);
    res.status(500).json({ message: 'Server error', error: error.message });
  }
});

// Complete Appointment
router.put('/:appointmentId/complete', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  const { callDuration, completedAt, prescriptionStatus } = req.body;
  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
    if (appointment.doctorId.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    appointment.status = 'completed';
    appointment.callDuration = callDuration;
    appointment.completedAt = completedAt || new Date();
    appointment.prescriptionStatus = prescriptionStatus || 'Pending';
    await appointment.save();

    const doctor = await Doctor.findById(appointment.doctorId);
    const patient = await Patient.findById(appointment.patientId);

    await Notification.create({
      recipient: appointment.patientId,
      recipientModel: "Patient",
      message: `Your appointment is completed by Dr. ${doctor ? doctor.name : 'Unknown'}`,
      doctorId: appointment.doctorId,
      appointmentId,
    });

    await sendCompletionEmail(patient, doctor, appointment);

    res.json({ message: 'Appointment completed successfully', appointment });
  } catch (error) {
    console.error('Error completing appointment:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Update Prescription Status
router.put('/:appointmentId/prescription-complete', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
    if (appointment.doctorId.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    appointment.prescriptionStatus = 'Completed';
    await appointment.save();
    res.json({ message: 'Prescription status updated successfully', appointment });
  } catch (error) {
    console.error('Error updating prescription status:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Get Appointment by ID
router.get("/:id", auth, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }
    const appointment = await Appointment.findById(req.params.id)
      .populate("doctorId", "name specialization")
      .populate("patientId", "name");
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    const isPatient = req.user.role === "patient" && appointment.patientId?._id.toString() === req.user.id;
    const isDoctor = req.user.role === "doctor" && appointment.doctorId?._id.toString() === req.user.id;
    if (!isPatient && !isDoctor) {
      return res.status(403).json({ message: "Unauthorized: You can only access your own appointments" });
    }

    res.json(appointment);
  } catch (error) {
    console.error("Error fetching appointment:", error.stack);
    res.status(500).json({ message: "Server error", details: error.message });
  }
});

// Update Notes
router.put('/:appointmentId/notes', authDoctor, async (req, res) => {
  const { appointmentId } = req.params;
  const { notes } = req.body;
  try {
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) return res.status(404).json({ message: 'Appointment not found' });
    if (appointment.doctorId.toString() !== req.user.id) return res.status(403).json({ message: 'Unauthorized' });

    appointment.notes = notes;
    await appointment.save();
    res.json({ message: 'Notes updated successfully', appointment });
  } catch (error) {
    console.error('Error updating notes:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Get Patient History
router.get('/patient/:patientId/history', authDoctor, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID" });
    }

    const appointmentExists = await Appointment.findOne({ 
      patientId, 
      doctorId: req.user.id 
    });
    if (!appointmentExists) {
      return res.status(403).json({ message: "Unauthorized: You do not have any appointments with this patient" });
    }

    const prescriptions = await Prescription.find({ patientId }).sort({ createdAt: -1 });
    const prescriptionsWithDoctor = await Promise.all(prescriptions.map(async (pres) => {
      const doctor = await Doctor.findById(pres.doctorId);
      return {
        ...pres._doc,
        createdAt: pres.createdAt || new Date(),
        doctorName: doctor ? doctor.name : 'Unknown Doctor'
      };
    }));

    res.json({ prescriptions: prescriptionsWithDoctor });
  } catch (error) {
    console.error('Fetch patient history error:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Upload Patient Records
router.post('/patient/:patientId/records', authDoctor, upload.single('file'), async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID" });
    }
    const file = req.file;
    if (!file) return res.status(400).json({ message: "No file uploaded" });

    const appointment = await Appointment.findOne({ patientId, doctorId: req.user.id }).sort({ date: -1 });
    if (!appointment) return res.status(404).json({ message: "No recent appointment found" });

    appointment.records = appointment.records || [];
    appointment.records.push({
      filename: file.filename,
      path: `uploads/${file.filename}`,
      uploadedAt: new Date(),
    });
    await appointment.save();

    res.json({ message: "Records uploaded successfully", file: { filename: file.filename, path: `uploads/${file.filename}` } });
  } catch (error) {
    console.error('Error uploading records:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Update Appointment Status
router.put("/:id", authDoctor, async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ message: "Invalid appointment ID format" });
    }

    const appointment = await Appointment.findById(req.params.id);
    if (!appointment) {
      return res.status(404).json({ message: "Appointment not found" });
    }

    if (appointment.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    appointment.status = req.body.status;
    await appointment.save();

    res.json(appointment);
  } catch (error) {
    console.error("Error updating appointment:", error.stack);
    res.status(500).json({ message: "Server error", details: error.message });
  }
});

// Get Prescription by Appointment ID
router.get('/prescriptions/appointment/:appointmentId', authDoctor, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }

    const prescription = await Prescription.findOne({ appointmentId })
      .populate('doctorId', 'name')
      .populate('patientId', 'name');

    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found for this appointment' });
    }

    if (prescription.doctorId._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    res.json(prescription);
  } catch (error) {
    console.error('Error fetching prescription:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Create Prescription with Backblaze B2 upload
router.post('/prescriptions', authDoctor, upload.single('pdf'), async (req, res) => {
  try {
    const { appointmentId, patientId, doctorId, medications, instructions, nextAppointmentDate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(appointmentId) || !mongoose.Types.ObjectId.isValid(patientId) || !mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    if (!appointmentId || !patientId || !doctorId || !medications) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (appointment.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    let uploadedFile = null;
    if (req.file) {
      const fileName = `prescription_${appointmentId}_${Date.now()}.pdf`;
      uploadedFile = await uploadPrescriptionToB2(appointmentId, req.file.path, fileName);
    }

    const prescription = new Prescription({
      appointmentId,
      patientId,
      doctorId,
      medications: JSON.parse(medications),
      instructions: instructions || '',
      nextAppointmentDate: nextAppointmentDate ? new Date(nextAppointmentDate) : undefined,
      pdfPath: uploadedFile ? uploadedFile.path : null,
      fileId: uploadedFile ? uploadedFile.fileId : null,
      createdAt: new Date(),
    });

    await prescription.save();

    const updatedAppointment = await Appointment.findByIdAndUpdate(
      appointmentId,
      { prescriptionStatus: 'Completed' },
      { new: true }
    );

    const doctor = await Doctor.findById(doctorId);
    const patient = await Patient.findById(patientId);
    if (!doctor || !patient) {
      throw new Error('Doctor or patient not found');
    }

    await Notification.create({
      recipient: patientId,
      recipientModel: 'Patient',
      message: `Your prescription has been created and sent to you by Dr. ${doctor.name}`,
      doctorId,
      appointmentId,
    });

    await sendPrescriptionEmail(patient, doctor, updatedAppointment, prescription);

    res.status(201).json({ message: 'Prescription created successfully', prescription });
  } catch (error) {
    console.error('Error creating prescription:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});




// Updated: Update Prescription with Backblaze B2 upload
router.put('/prescriptions/:prescriptionId', authDoctor, upload.single('pdf'), async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    const { medications, instructions, nextAppointmentDate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ message: 'Invalid prescription ID' });
    }

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    if (prescription.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized' });
    }

    let pdfUrl = prescription.pdfPath;
    if (req.file) {
      const uploadedFiles = await uploadBucketListToB2(prescription.appointmentId, prescription.patientId, [req.file]);
      pdfUrl = uploadedFiles[0].url;
    }

    prescription.medications = medications ? JSON.parse(medications) : prescription.medications;
    prescription.instructions = instructions || prescription.instructions;
    prescription.nextAppointmentDate = nextAppointmentDate ? 
      new Date(nextAppointmentDate) : prescription.nextAppointmentDate;
    prescription.pdfPath = pdfUrl;
    prescription.updatedAt = new Date();

    await prescription.save();

    const doctor = await Doctor.findById(prescription.doctorId);
    const patient = await Patient.findById(prescription.patientId);
    const appointment = await Appointment.findById(prescription.appointmentId);

    await Notification.create({
      recipient: prescription.patientId,
      recipientModel: 'Patient',
      message: `Your prescription has been updated by Dr. ${doctor ? doctor.name : 'Unknown'}`,
      doctorId: prescription.doctorId,
      appointmentId: prescription.appointmentId,
    });

    await sendPrescriptionEmail(patient, doctor, appointment, prescription);

    res.json({ message: 'Prescription updated successfully', prescription });
  } catch (error) {
    console.error('Error updating prescription:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Get Prescriptions for Patient
router.get('/patient/:patientId/prescriptions', authPatient, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: 'Invalid patient ID' });
    }

    if (req.user.id !== patientId) {
      return res.status(403).json({ message: 'Unauthorized: You can only view your own prescriptions' });
    }

    const prescriptions = await Prescription.find({ patientId })
      .populate('doctorId', 'name')
      .populate('appointmentId', 'date')
      .sort({ createdAt: -1 });

    res.status(200).json(prescriptions);
  } catch (error) {
    console.error('Error fetching patient prescriptions:', error.stack);
    res.status(500).json({ message: 'Internal server error', details: error.message });
  }
});


// New Endpoint: Doctor starts the call
router.post('/start-call/:appointmentId', authDoctor, async (req, res) => {
  try {
    const { appointmentId } = req.params;

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }

    const appointment = await Appointment.findById(appointmentId)
      .populate('patientId', 'name email')
      .populate('doctorId', 'name');
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (appointment.doctorId._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: Only the assigned doctor can start the call' });
    }

    // Check if the appointment is in a valid state to start
    if (appointment.status !== 'accepted') {
      return res.status(400).json({ message: 'Cannot start call: Appointment must be accepted first' });
    }

    // Update appointment status (optional)
    appointment.status = 'in-progress'; // Add this status to your schema if not already present
    await appointment.save();

    const patient = await Patient.findById(appointment.patientId._id);
    const doctor = await Doctor.findById(appointment.doctorId._id);

    // Save notification in the database
    await Notification.create({
      recipient: appointment.patientId._id,
      recipientModel: 'Patient',
      message: `Dr. ${doctor.name} has started your video consultation. Please join the call now.`,
      doctorId: appointment.doctorId._id,
      appointmentId,
    });

    // Get Socket.IO instance from app
    const io = req.app.get('socketio');
    
    // Emit real-time notification to the patient’s room
    io.to(appointment.patientId._id.toString()).emit('callStarted', {
      appointmentId: appointment._id,
      doctorName: doctor.name,
      message: `Dr. ${doctor.name} has started your video consultation.`,
      joinUrl: `https://turemedicine.com/patient/call/${appointment._id}`, // Adjust URL
    });

    // Send email notification (optional fallback)
    await sendCallStartedEmail(patient, doctor, appointment);

    res.status(200).json({ 
      message: 'Call started successfully', 
      appointment 
    });
  } catch (error) {
    console.error('Error starting call:', error.stack);
    res.status(500).json({ message: 'Failed to start call', details: error.message });
  }
});

// New: Send email when doctor starts the call
const sendCallStartedEmail = async (patient, doctor, appointment) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: patient.email,
    subject: 'TureMedicine: Your Video Consultation Has Started',
    html: `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #2ecc71;">Video Consultation Started!</h2>
        <p>Dear ${patient.name},</p>
        <p>Dr. ${doctor.name} has started your video consultation.</p>
        <h3>Appointment Details</h3>
        <p>Appointment ID: ${appointment._id}</p>
        <p>Date: ${new Date(appointment.date).toLocaleString()}</p>
        <p><strong>Please join the call immediately:</strong> <a href="https://turemedicine.com/patient/call/${appointment._id}">Join Now</a></p>
        <p>Best regards,<br/>The TureMedicine Team</p>
      </div>
    `,
  };

  await transporter.sendMail(mailOptions);
};


// ... (Previous imports and code remain unchanged)

// Generate Pre-Signed URL for Prescription Download (Existing)
router.get('/prescriptions/:prescriptionId/download', authPatient, async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ message: 'Invalid prescription ID' });
    }

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    if (prescription.patientId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only download your own prescriptions' });
    }

    const fileName = prescription.pdfPath;
    if (!fileName) {
      return res.status(400).json({ message: 'No file path available for this prescription' });
    }

    const { data: signedUrlData } = await b2.getDownloadAuthorization({
      bucketId: b2BucketId,
      fileNamePrefix: `appointments/${prescription.appointmentId}/`,
      validDurationInSeconds: 3600, // 1 hour validity
    });

    const downloadUrl = `${b2.downloadUrl}/file/${process.env.B2_BUCKET_NAME}/${fileName}?Authorization=${signedUrlData.authorizationToken}`;
    res.status(200).json({ downloadUrl });
  } catch (error) {
    console.error('Error generating download URL:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Download Prescription File Directly (New)
router.get('/prescriptions/:prescriptionId/download-direct', authPatient, async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ message: 'Invalid prescription ID' });
    }

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    if (prescription.patientId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only download your own prescriptions' });
    }

    const fileName = prescription.pdfPath;
    if (!fileName) {
      return res.status(400).json({ message: 'No file path available for this prescription' });
    }

    // Optional: Verify file exists using fileId if available
    if (prescription.fileId) {
      try {
        const { data: fileInfo } = await b2.getFileInfo({
          fileId: prescription.fileId,
        });
        console.log(`File verified in B2: ${fileInfo.fileName}, fileId: ${fileInfo.fileId}`);
      } catch (fileError) {
        console.error(`File check failed for fileId ${prescription.fileId}:`, fileError.message);
        if (fileError.response?.status === 400) {
          console.error('Bad request to B2 - invalid fileId');
        }
        // Proceed to download anyway
      }
    } else {
      console.warn(`No fileId for prescription ${prescription._id}, attempting download with fileName`);
    }

    console.log(`Attempting to download file from B2: ${fileName}`);
    const { data: fileStream } = await b2.downloadFileByName({
      bucketName: process.env.B2_BUCKET_NAME,
      fileName,
      responseType: 'stream',
    });

    res.setHeader('Content-Disposition', `attachment; filename="prescription_${prescription._id}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    fileStream.pipe(res);
  } catch (error) {
    console.error('Error downloading prescription file:', error.stack);
    if (error.response?.status === 400) {
      return res.status(400).json({ message: 'Invalid request to storage - file may not exist or parameters are incorrect' });
    }
    if (error.response?.status === 404) {
      return res.status(404).json({ message: 'Prescription file not found in storage' });
    }
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Download Prescription File Directly for Doctor (New)
router.get('/prescriptions/:prescriptionId/download-direct-doctor', authDoctor, async (req, res) => {
  try {
    const { prescriptionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(prescriptionId)) {
      return res.status(400).json({ message: 'Invalid prescription ID' });
    }

    const prescription = await Prescription.findById(prescriptionId);
    if (!prescription) {
      return res.status(404).json({ message: 'Prescription not found' });
    }
    if (prescription.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only download prescriptions you created' });
    }

    const fileName = prescription.pdfPath;
    if (!fileName) {
      return res.status(400).json({ message: 'No file path available for this prescription' });
    }

    const { data: fileStream } = await b2.downloadFileByName({
      bucketName: process.env.B2_BUCKET_NAME,
      fileName,
      responseType: 'stream',
    });

    res.setHeader('Content-Disposition', `attachment; filename="prescription_${prescription._id}.pdf"`);
    res.setHeader('Content-Type', 'application/pdf');

    fileStream.pipe(res);

  } catch (error) {
    console.error('Error downloading prescription file for doctor:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

module.exports = router;