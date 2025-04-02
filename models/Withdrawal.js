const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', required: true },
  amount: { type: Number, required: true },
  method: { type: String, required: true },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  requestDate: { type: Date, default: Date.now },
  transactionId: { type: String },
  paymentMode: { type: String, enum: ['Bank Transfer', 'UPI', 'Paytm', 'Other'] },
  approvedAmount: { type: Number },
  dateOfPayment: { type: Date },
  rejectionReason: { type: String },
  dateOfRejection: { type: Date },
  invoicePath: { type: String },
  withdrawalId: { type: String, unique: true }, // Optional: unique identifier for the withdrawal
  receiptPath: { type: String, default: null },
}, { timestamps: true });

withdrawalSchema.pre('save', async function (next) {
  if (!this.withdrawalId) {
    const count = await mongoose.model('Withdrawal').countDocuments();
    this.withdrawalId = `#WD${String(count + 1).padStart(4, '0')}`;
  }
  next();
});

module.exports = mongoose.model('Withdrawal', withdrawalSchema);