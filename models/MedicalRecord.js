const mongoose = require('mongoose');

const medicalRecordSchema = new mongoose.Schema({
  patientId: { type: String, required: true },
  fileName: { type: String, required: true },
  filePath: { type: String, required: true },
  fileType: { type: String, required: true }, // e.g., 'pdf', 'jpeg', 'png', 'doc'
  fileSize: { type: Number, required: true }, // Size in bytes
  uploadedBy: { type: String, enum: ['Patient', 'Doctor', 'System'], required: true },
  description: { type: String }, // e.g., "Blood Test Report", "X-ray"
  uploadDate: { type: Date, default: Date.now }
});

module.exports = mongoose.model('MedicalRecord', medicalRecordSchema);