const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

// Import routes
const dashboardRoutes = require('./routes/dashboardRoutes');
const profileRoutes = require('./routes/profileRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const patientRoutes = require('./routes/patientRoutes');
const consultationRoutes = require('./routes/consultationRoutes');
const earningsRoutes = require('./routes/earningsRoutes');
const feedbackRoutes = require('./routes/feedbackRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const supportRoutes = require('./routes/supportRoutes');
const securityRoutes = require('./routes/securityRoutes');
const doctorRoutes = require('./routes/doctorRoutes');
const appointmentRoutes = require('./routes/appointmentRoutes');
const cors = require('cors');
const doctorRoutes = require('./routes/doctorRoutes');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect('mongodb://localhost:27017/truemedicine', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/patients', patientRoutes);
app.use('/api/consultation', consultationRoutes);
app.use('/api/earnings', earningsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/security', securityRoutes);
app.use('/api', appointmentRoutes); // Mount the route
app.use('/api/doctors', doctorRoutes); // Mount the route



// Export the app
module.exports = app;

const doctorRoutes = require('./routes/doctorRoutes');
app.use('/api', doctorRoutes); // Mount the route
app.use(cors()); // Enable CORS for all routes