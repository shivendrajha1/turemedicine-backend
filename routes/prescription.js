// backend/routes/prescription.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Prescription = require('../models/Prescription');
const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const { authDoctor, auth, authAdmin } = require('../middlewares/authMiddleware'); // Correct import
const multer = require('multer');
const path = require('path');
const fs = require('fs');

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

router.post('/', authDoctor, upload.single('pdf'), async (req, res) => {
  try {
    const { appointmentId, patientId, medications, instructions, nextAppointmentDate } = req.body;
    const doctorId = req.user.id;

    console.log("Prescription request headers:", req.headers);
    console.log("Prescription request body:", req.body);
    console.log("Authenticated doctorId (req.user.id):", doctorId);
    console.log("Uploaded file:", req.file);

    // Validate required fields
    if (!appointmentId || !patientId || !medications) {
      console.log("Missing required fields:", { appointmentId, patientId, medications });
      return res.status(400).json({ message: "appointmentId, patientId, and medications are required" });
    }

    // Validate ObjectIds
    const isValidAppointmentId = mongoose.Types.ObjectId.isValid(appointmentId);
    const isValidPatientId = mongoose.Types.ObjectId.isValid(patientId);
    if (!isValidAppointmentId || !isValidPatientId) {
      console.log("Invalid ObjectId format:", { appointmentId, patientId });
      return res.status(400).json({ message: `Invalid appointmentId (${appointmentId}) or patientId (${patientId})` });
    }

    // Verify the appointment exists and permissions
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      console.log("Appointment not found:", appointmentId);
      return res.status(404).json({ message: "Appointment not found" });
    }
    console.log("Appointment doctorId:", appointment.doctorId.toString());
    if (appointment.doctorId.toString() !== doctorId) {
      console.log("Unauthorized - Doctor mismatch:", { appointmentDoctorId: appointment.doctorId.toString(), userId: doctorId });
      return res.status(403).json({ message: "Unauthorized: You do not have permission to submit a prescription for this appointment" });
    }
    if (appointment.patientId.toString() !== patientId) {
      console.log("Patient ID mismatch:", { appointmentPatientId: appointment.patientId.toString(), providedPatientId: patientId });
      return res.status(400).json({ message: "Patient ID does not match the appointment" });
    }

    // Parse medications
    let parsedMedications;
    try {
      parsedMedications = JSON.parse(medications);
      if (!Array.isArray(parsedMedications) || parsedMedications.length === 0) {
        console.log("Medications must be a non-empty array:", medications);
        return res.status(400).json({ message: "Medications must be a non-empty array" });
      }
      for (const med of parsedMedications) {
        if (!med.name || !med.dosage || !med.frequency || !med.duration) {
          console.log("Invalid medication entry:", med);
          return res.status(400).json({ message: "All medication fields (name, dosage, frequency, duration) are required" });
        }
      }
    } catch (e) {
      console.log("Invalid medications format:", e.message);
      return res.status(400).json({ message: "Invalid medications format", details: e.message });
    }

    // Create prescription
    const prescription = new Prescription({
      appointmentId,
      patientId,
      doctorId,
      medications: parsedMedications,
      instructions: instructions || "",
      nextAppointmentDate: nextAppointmentDate ? new Date(nextAppointmentDate) : null,
      pdfPath: req.file ? `uploads/${req.file.filename}` : null,
    });

    await prescription.save();
    console.log("Prescription saved:", prescription);

    // Create notification if PDF is uploaded
    if (req.file) {
      console.log("Uploaded file:", req.file);
      try {
        const notification = await Notification.create({
          recipient: patientId,
          recipientModel: "Patient",
          message: "Your prescription has been issued. Download it from your records.",
          doctorId,
          appointmentId,
          attachment: `uploads/${req.file.filename}`,
        });
        console.log("Notification created:", notification);
      } catch (notifyError) {
        console.error("Failed to create notification:", notifyError.stack);
      }
    }

    res.status(201).json({ message: "Prescription created successfully", prescription });
  } catch (error) {
    console.error('Error creating prescription:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

router.get('/patient/:patientId', auth, async (req, res) => {
  try {
    const { patientId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: "Invalid patient ID" });
    }

    if (req.user.role === "patient" && req.user.id !== patientId) {
      return res.status(403).json({ message: "Unauthorized" });
    }
    if (req.user.role === "doctor") {
      const appointmentExists = await Appointment.findOne({ 
        patientId, 
        doctorId: req.user.id 
      });
      if (!appointmentExists) {
        return res.status(403).json({ message: "Unauthorized: No appointments exist with this patient" });
      }
    }

    const prescriptions = await Prescription.find({ patientId })
      .populate("appointmentId", "date")
      .sort({ createdAt: -1 });
    res.json(prescriptions);
  } catch (error) {
    console.error('Error fetching prescriptions:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

router.get('/appointment/:appointmentId', auth, async (req, res) => {
  try {
    const { appointmentId } = req.params;
    console.log(`Fetching prescription for appointmentId: ${appointmentId}, user: ${req.user.id}, role: ${req.user.role}`);

    if (!mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointment ID' });
    }

    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      console.log(`Appointment not found: ${appointmentId}`);
      return res.status(404).json({ message: 'Appointment not found' });
    }

    const isPatient = req.user.role === "patient" && appointment.patientId.toString() === req.user.id;
    const isDoctor = req.user.role === "doctor" && appointment.doctorId.toString() === req.user.id;
    if (!isPatient && !isDoctor) {
      console.log(`Unauthorized access attempt: User ${req.user.id} (${req.user.role}) for appointment ${appointmentId}`);
      return res.status(403).json({ message: 'Unauthorized: You can only access your own appointments’ prescriptions' });
    }

    const prescription = await Prescription.findOne({ appointmentId })
      .populate('doctorId', 'name')
      .populate('patientId', 'name');

    if (!prescription) {
      console.log(`No prescription found for appointmentId: ${appointmentId}`);
      return res.status(404).json({ message: 'Prescription not found for this appointment' });
    }

    console.log('Prescription sent to frontend:', prescription);
    res.json(prescription);
  } catch (error) {
    console.error('Error fetching prescription:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// routes/prescription.js (inside /doctor/:doctorId)
router.get('/doctor/:doctorId', authAdmin, async (req, res) => {
  console.log('Request headers:', req.headers); // Log headers
  try {
    const { doctorId } = req.params;
    const prescriptions = await Prescription.find({ doctorId })
      .populate('appointmentId', 'date')
      .sort({ createdAt: -1 });
    res.json(prescriptions);
  } catch (error) {
    console.error('Error fetching prescriptions:', error.stack);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});



router.get('/appointments/patient/:patientId/history', authDoctor, async (req, res) => {
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
    console.error('Fetch patient history error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

module.exports = router;