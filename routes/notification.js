const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Notification = require('../models/Notification');
const { authNotificationPatient, authNotificationDoctor, auth } = require('../middlewares/authMiddleware');

// Create a notification (accessible to doctors and admins)
router.post('/', auth, async (req, res) => {
  try {
    const { recipient, recipientModel, message, doctorId, appointmentId, signalData } = req.body;

    console.log('POST /notifications received:', { recipient, recipientModel, message, doctorId, appointmentId });

    if (!recipient || !message) {
      return res.status(400).json({ message: 'Recipient and message are required' });
    }

    if (!mongoose.Types.ObjectId.isValid(recipient)) {
      return res.status(400).json({ message: 'Invalid recipient ID format' });
    }
    if (doctorId && !mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: 'Invalid doctorId format' });
    }
    if (appointmentId && !mongoose.Types.ObjectId.isValid(appointmentId)) {
      return res.status(400).json({ message: 'Invalid appointmentId format' });
    }

    // Allow 'doctor', 'admin', or 'superadmin' roles
    if (req.user.role === 'doctor' && doctorId && doctorId !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: Doctor ID does not match authenticated user' });
    }
    if (!['doctor', 'admin', 'superadmin'].includes(req.user.role)) {
      return res.status(403).json({ message: 'Unauthorized: Only doctors and admins can create notifications' });
    }

    const notification = new Notification({
      recipient,
      recipientModel: recipientModel || 'Patient',
      message,
      sender: req.user.id,
      senderModel: req.user.role === 'superadmin' ? 'Admin' : (req.user.role === 'admin' ? 'Admin' : 'Doctor'),
      doctorId: doctorId || null,
      appointmentId: appointmentId || null,
      signalData: signalData || null,
    });

    await notification.save();
    res.status(201).json({ message: 'Notification created successfully', notification });
  } catch (error) {
    console.error('Error sending notification:', error.stack);
    res.status(500).json({ message: 'Internal server error', details: error.message });
  }
});

// Fetch notifications for a patient (including admin notifications)
router.get('/patient/:patientId', authNotificationPatient, async (req, res) => {
  try {
    const { patientId } = req.params;
    console.log('Fetching notifications for patientId:', patientId);
    console.log('Authenticated user:', req.user);

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
      return res.status(400).json({ message: 'Invalid patient ID' });
    }

    if (req.user.id !== patientId) {
      console.log('Unauthorized access: req.user.id does not match patientId');
      return res.status(403).json({ message: 'Unauthorized: Patients can only view their own notifications' });
    }

    const notifications = await Notification.find({ 
      recipient: patientId,
    }).sort({ createdAt: -1 });

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching patient notifications:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Fetch notifications for a doctor
router.get('/doctor/:doctorId', authNotificationDoctor, async (req, res) => {
  try {
    const { doctorId } = req.params;
    console.log('Fetching notifications for doctorId:', doctorId);
    console.log('Authenticated user:', req.user);

    if (!mongoose.Types.ObjectId.isValid(doctorId)) {
      return res.status(400).json({ message: 'Invalid doctor ID' });
    }

    if (req.user.id !== doctorId) {
      console.log('Unauthorized access: req.user.id does not match doctorId');
      return res.status(403).json({ message: 'Unauthorized: Doctors can only view their own notifications' });
    }

    const notifications = await Notification.find({ 
      recipient: doctorId,
      recipientModel: 'Doctor',
    }).sort({ createdAt: -1 });

    res.json(notifications);
  } catch (error) {
    console.error('Error fetching doctor notifications:', error.stack);
    res.status(500).json({ message: 'Server error', details: error.message });
  }
});

// Mark a notification as read
router.put('/:id/read', authNotificationPatient, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: 'Invalid notification ID' });
    }

    const notification = await Notification.findById(id);
    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    if (notification.recipient.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Unauthorized: You can only mark your own notifications as read' });
    }

    notification.read = true;
    await notification.save();
    res.status(200).json({ message: 'Notification marked as read', notification });
  } catch (error) {
    console.error('Error marking notification as read:', error.stack);
    res.status(500).json({ message: 'Failed to mark notification as read', details: error.message });
  }
});

// Deprecated admin-specific endpoint (merged into main POST /notifications)
router.post('/admin', auth, async (req, res) => {
  return res.status(410).json({ message: 'This endpoint is deprecated. Use POST /notifications with admin authentication instead.' });
});

module.exports = router;