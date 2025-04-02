const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  totalFee: Number,
  paymentStatus: { type: String, default: 'pending' }, // 'pending', 'paid'
  date: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Payment', paymentSchema);