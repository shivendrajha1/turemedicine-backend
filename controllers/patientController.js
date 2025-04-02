const Patient = require('../models/Patient'); // Import the Patient model

// Get patient profile
exports.getProfile = async (req, res) => {
  try {
    // The authenticated patient's ID is attached to the request object by the middleware
    const patientId = req.user._id;

    // Fetch the patient's profile from the database
    const patient = await Patient.findById(patientId).select('-password'); // Exclude the password field for security
    if (!patient) {
      return res.status(404).json({ message: 'Patient not found' });
    }

    res.status(200).json(patient);
  } catch (error) {
    console.error('Error fetching patient profile:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};

// Update patient profile
exports.updateProfile = async (req, res) => {
  try {
    // The authenticated patient's ID is attached to the request object by the middleware
    const patientId = req.user._id;

    // Extract updated fields from the request body
    const { name, email, phone, address } = req.body;

    // Find the patient by ID and update their profile
    const updatedPatient = await Patient.findByIdAndUpdate(
      patientId,
      { name, email, phone, address }, // Fields to update
      { new: true } // Return the updated document
    ).select('-password'); // Exclude the password field for security

    if (!updatedPatient) {
      return res.status(404).json({ message: 'Patient not found' });
    }

    res.status(200).json(updatedPatient);
  } catch (error) {
    console.error('Error updating patient profile:', error);
    res.status(500).json({ message: 'Internal server error' });
  }
};