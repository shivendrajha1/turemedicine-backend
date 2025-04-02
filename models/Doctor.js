const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const doctorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  phone: { type: String, required: true },
  specialization: { type: String, required: true },
  state: { type: String, required: true },
  city: { type: String, required: true },
  experience: { type: Number, required: true },
  address: { type: String, required: true },
  password: { type: String, required: true },
  consultationFee: { type: Number, default: 0 },
  availability: {
    type: Map,
    of: [String],
    default: () => new Map()
  },
  isVerified: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  accountStatus: { type: String, enum: ['active', 'deactivated', 'deleted'], default: 'active' },
  deactivationReason: { type: String, default: '' },
  documents: {
    medicalLicense: { type: String, required: true },
    degreeCertificate: { type: String, required: true },
    idProof: { type: String, required: true },
  },
  bankDetails: {
    accountHolderName: { type: String, default: '' },
    bankName: { type: String, default: '' },
    branchName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    confirmAccountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    upiId: { type: String, default: '' },
    paytmNumber: { type: String, default: '' },
    googlePayNumber: { type: String, default: '' },
    phonePeNumber: { type: String, default: '' }
  },
  refreshToken: { type: String },
  profilePicture: { type: String, default: "https://via.placeholder.com/80" },
  resetToken: { type: String }, // Already present
});

doctorSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 10);
  next();
});

doctorSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('Doctor', doctorSchema);