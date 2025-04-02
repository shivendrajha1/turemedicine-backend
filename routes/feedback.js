// backend/routes/feedback.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Feedback = require('../models/Feedback');
const Appointment = require('../models/Appointment');
const { authPatient, authDoctor } = require('../middlewares/authMiddleware'); // Ensure correct import

// Submit feedback (Patient)
router.post('/', authPatient, async (req, res) => {
  try {
    const { appointmentId, doctorId, patientId, rating, feedback } = req.body;

    // Validate required fields
    if (!appointmentId || !doctorId || !patientId || !rating) {
      return res.status(400).json({ message: 'appointmentId, doctorId, patientId, and rating are required' });
    }

    // Validate ObjectIds
    if (!mongoose.Types.ObjectId.isValid(appointmentId) || 
        !mongoose.Types.ObjectId.isValid(doctorId) || 
        !mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: 'Invalid ID format' });
    }

    // Verify the appointment exists and the patient matches the authenticated user
    const appointment = await Appointment.findById(appointmentId);
    if (!appointment) {
      return res.status(404).json({ message: 'Appointment not found' });
    }
    if (appointment.patientId.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only submit feedback for your own appointments' });
    }
    if (appointment.doctorId.toString() !== doctorId) {
      return res.status(403).json({ message: 'Unauthorized: Doctor does not match the appointment' });
    }

    // Check if feedback already exists for this appointment
    const existingFeedback = await Feedback.findOne({ appointmentId });
    if (existingFeedback) {
      return res.status(400).json({ message: 'Feedback already submitted for this appointment' });
    }

    // Create new feedback
    const newFeedback = new Feedback({
      appointmentId,
      doctorId,
      patientId,
      rating,
      feedback,
    });

    await newFeedback.save();
    res.status(201).json({ message: 'Feedback submitted successfully' });
  } catch (error) {
    console.error('Error submitting feedback:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Get feedback for a doctor (for DoctorFeedback.js)
router.get('/doctor/:doctorId', authDoctor, async (req, res) => {
  try {
    const { doctorId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: "Invalid doctor ID" });
    }

    if (req.user.id !== doctorId) {
      return res.status(403).json({ message: "Unauthorized: Doctors can only view their own feedback" });
    }

    const feedbacks = await Feedback.find({ doctorId })
      .populate('patientId', 'name')
      .sort({ createdAt: -1 });
    res.json(feedbacks);
  } catch (error) {
    console.error('Error fetching feedback:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

module.exports = router;