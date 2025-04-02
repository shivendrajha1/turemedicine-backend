const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

const patientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: String,
  address: String,
  gender: String,
  age: { type: Number }, // Replaced dateOfBirth with age
  accountStatus: { 
    type: String, 
    default: 'active', 
    enum: ['active', 'deactivated', 'banned']
  },
  refreshToken: { type: String },
  pushTokens: { 
    type: [String],
    default: [],
  },
  pushToken: { 
    type: String, 
    default: null 
  },
  resetToken: { type: String },
});

patientSchema.pre('save', async function(next) {
  if (this.isModified('password')) {
    this.password = await bcrypt.hash(this.password, 10);
  }
  next();
});

patientSchema.methods.matchPassword = async function(password) {
  return await bcrypt.compare(password, this.password);
};

module.exports = mongoose.model('Patient', patientSchema);