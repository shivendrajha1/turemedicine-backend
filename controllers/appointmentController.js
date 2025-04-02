const mongoose = require('mongoose');
const Appointment = require('../models/Appointment');

// Fetch appointments by patient ID
exports.getAppointmentsByPatientId = async (req, res) => {
    try {
        const { patientId } = req.params;

        // Validate patientId
        if (!mongoose.Types.ObjectId.isValid(patientId)) {
            return res.status(400).json({ error: 'Invalid patient ID' });
        }

        // Find appointments for the patient
        const appointments = await Appointment.find({ patientId })
            .populate('doctorId', 'name specialization') // Populate doctor details
            .sort({ date: 1 }); // Sort by date

        if (!appointments || appointments.length === 0) {
            return res.status(404).json({ message: 'No appointments found for this patient' });
        }

        res.status(200).json(appointments);
    } catch (error) {
        console.error('Error fetching appointments:', error);
        res.status(500).json({ error: 'Server error' });
    }
};