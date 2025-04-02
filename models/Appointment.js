const mongoose = require("mongoose");

const appointmentSchema = new mongoose.Schema(
  {
    patientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Patient",
      required: true,
    },
    name: { type: String, required: true },
    age: { type: Number, required: true },
    gender: { type: String, required: true },
    doctorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Doctor",
      required: true,
    },
    date: { type: Date, required: true }, // Original appointment date
    rescheduledDate: { type: Date }, // Date for rescheduled appointments (optional)
    symptoms: { type: String },
    consultationFee: { type: Number, required: true },
    totalFee: { type: Number, required: true },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "failed", "refunded"],
      default: "pending",
    },
    status: {
      type: String,
      enum: ["pending", "accepted", "rejected", "rescheduled", "completed", "canceled"],
      default: "pending",
    },
    rejectReason: { type: String, default: "" },
    bookingStatus: {
      type: String,
      enum: ["pending", "booked", "not_booked"],
      default: "pending",
    },
    notes: { type: String },
    records: [{
      filename: String,
      path: String,
      uploadedAt: { type: Date, default: Date.now },
    }],
    callDuration: { type: String },
    completedAt: { type: Date },
    prescriptionStatus: {
      type: String,
      enum: ["Pending", "Completed"],
      default: "Pending",
    },
    rescheduleReason: { type: String },
    patientCommissionRate: { type: Number, required: true },
    doctorCommissionRate: { type: Number, required: true },
    paymentDetails: {
      orderId: { type: String }, // Razorpay order ID
      paymentId: { type: String }, // Razorpay payment ID (used as transaction ID in frontend)
      signature: { type: String }, // Razorpay payment signature
      method: { type: String, default: "N/A" }, // Payment method (e.g., UPI, Card, Net Banking)
      amountPaid: { type: Number, default: 0 }, // Exact amount paid
      paidAt: { type: Date }, // Date of payment (replaces paymentDate in frontend)
      status: { 
        type: String, 
        enum: ["pending", "paid", "refunded"], 
        default: "pending" 
      }, // Payment status
      invoicePath: { type: String }, // Path to generated invoice PDF
    },
    refundStatus: {
      type: String,
      enum: ["Pending", "Approved", "Processed", "Failed", null],
      default: null,
    },
    refundedAt: { type: Date }, // Date of refund
    refundDetails: {
      refundId: { type: String }, // Razorpay refund ID
      amount: { type: Number }, // Refunded amount
      status: { type: String }, // Refund status
      createdAt: { type: Date }, // Date refund was created
      cancellationFee: Number, // Add this field
      gatewayFee: Number,
      gstOnGatewayFee: Number,
      restAfterRefund: Number,
    },
    cancellationReason: { type: String }, // Reason for cancellation
  },
  { timestamps: true }
);

const Appointment = mongoose.models.Appointment || mongoose.model("Appointment", appointmentSchema);

module.exports = Appointment;