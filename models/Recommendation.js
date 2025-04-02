const mongoose = require('mongoose');

const recommendationSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    message: { type: String, required: true },
    date: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Recommendation', recommendationSchema);