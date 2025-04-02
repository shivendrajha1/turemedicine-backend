const Doctor = require('../models/Doctor'); // Assuming you have a Doctor model

exports.getDoctorsByLocation = async (req, res) => {
    const { state, city } = req.query;

    try {
        if (!state || !city) {
            return res.status(400).json({ error: 'State and city are required' });
        }

        const doctors = await Doctor.find({ state, city });
        res.status(200).json(doctors);
    } catch (error) {
        console.error('Error fetching doctors:', error.message);
        res.status(500).json({ error: 'Internal Server Error' });
    }
};