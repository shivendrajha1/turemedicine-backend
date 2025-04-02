const mongoose = require('mongoose');

const validatePatientId = (req, res, next) => {
    const { patientId } = req.body;

    if (!patientId) {
        return res.status(400).json({ error: 'patientId is required' });
    }

    if (!mongoose.Types.ObjectId.isValid(patientId)) {
        return res.status(400).json({ error: `Invalid patientId: ${patientId}` });
    }

    next();
};

module.exports = validateAppointment;