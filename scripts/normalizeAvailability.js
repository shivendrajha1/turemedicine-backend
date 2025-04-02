const mongoose = require('mongoose'); // Add this if not already required
const Doctor = require('../models/Doctor'); // Adjust the path based on your project structure

// Define days of week
const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

async function normalizeDatabaseAvailability() {
  try {
    // Connect to MongoDB if not already connected (optional, depending on your setup)
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/your-database', {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    const doctors = await Doctor.find();
    for (const doctor of doctors) {
      const normalized = {};
      Object.entries(doctor.availability || {}).forEach(([key, value]) => {
        if (!isNaN(key)) {
          const dayIndex = parseInt(key) % daysOfWeek.length;
          normalized[daysOfWeek[dayIndex]] = Array.isArray(value) ? value : [];
        } else {
          const matchedDay = daysOfWeek.find(d => d.toLowerCase() === key.toLowerCase());
          if (matchedDay) {
            normalized[matchedDay] = Array.isArray(value) ? value : [];
          }
        }
      });
      doctor.availability = normalized;
      await doctor.save();
      console.log(`Normalized availability for doctor: ${doctor.name}`);
    }

    console.log('Database availability normalized successfully');
  } catch (error) {
    console.error('Error normalizing database availability:', error);
  } finally {
    // Disconnect from MongoDB (optional)
    await mongoose.disconnect();
  }
}

normalizeDatabaseAvailability();