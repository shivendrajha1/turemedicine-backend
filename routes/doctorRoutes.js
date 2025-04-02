const express = require("express");
const Doctor = require("../models/Doctor");
const Appointment = require("../models/Appointment");
const Withdrawal = require("../models/Withdrawal");
const Patient = require("../models/Patient");
const PlatformSettings = require("../models/PlatformSettings");
const Feedback = require("../models/Feedback"); // Add Feedback model
const { authDoctor } = require("../middlewares/authMiddleware");
const B2 = require("backblaze-b2"); // Import Backblaze B2
const { createClient } = require("@supabase/supabase-js"); // Import Supabase
const multer = require("multer"); // Add multer for file uploads
const router = express.Router();

// Debug environment variable
console.log('B2_DOWNLOAD_URL:', process.env.B2_DOWNLOAD_URL);

// Backblaze B2 Configuration
const b2 = new B2({
  applicationKeyId: process.env.B2_APPLICATION_KEY_ID,
  applicationKey: process.env.B2_APPLICATION_KEY,
});

// Initialize B2
let b2BucketId = null;
const initializeB2 = async () => {
  try {
    const authResponse = await b2.authorize();
    const bucketResponse = await b2.getBucket({ bucketName: process.env.B2_BUCKET_NAME });
    b2BucketId = bucketResponse.data.buckets[0].bucketId;
    console.log('B2 initialized:', { b2BucketId });
  } catch (err) {
    console.error('B2 initialization error:', err.stack);
    throw err;
  }
};

// Run initialization at startup
(async () => {
  await initializeB2();
})();

// Multer configuration for file uploads
const upload = multer({ storage: multer.memoryStorage() });

// Debug environment variables
console.log('SUPABASE_URL:', process.env.SUPABASE_URL);
console.log('SUPABASE_SERVICE_ROLE_KEY:', process.env.SUPABASE_SERVICE_ROLE_KEY ? 'Set' : 'Not Set');
console.log('SUPABASE_BUCKET_NAME:', process.env.SUPABASE_BUCKET_NAME);
// Supabase Configuration with service_role key
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Upload file to Supabase Storage
const uploadToSupabase = async (file, folder) => {
  try {
    if (!file || !file.buffer) {
      throw new Error("No file provided or file buffer is missing");
    }

    const fileName = `${folder}/${Date.now()}_${file.originalname}`;
    const { data, error } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET_NAME)
      .upload(fileName, file.buffer, {
        contentType: file.mimetype,
        upsert: true, // Overwrite if file exists
      });

    if (error) {
      console.error('Supabase upload error details:', error);
      throw new Error(`Supabase upload failed: ${error.message}`);
    }

    // Get public URL (if bucket is public)
    const publicUrl = `${process.env.SUPABASE_URL}/storage/v1/object/public/${process.env.SUPABASE_BUCKET_NAME}/${fileName}`;
    console.log('Uploaded to Supabase:', { fileName, publicUrl });
    return publicUrl;

    // Alternative: Signed URL (if bucket is private)
    /*
    const { data: signedData, error: signedError } = await supabase.storage
      .from(process.env.SUPABASE_BUCKET_NAME)
      .createSignedUrl(fileName, 60 * 60 * 24 * 7); // 7-day expiration
    if (signedError) throw signedError;
    console.log('Signed URL:', signedData.signedUrl);
    return signedData.signedUrl;
    */
  } catch (err) {
    console.error(`Error uploading to Supabase (${folder}):`, err.stack || err);
    throw new Error(`Failed to upload file to Supabase: ${err.message}`);
  }
};

const daysOfWeek = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

// Doctor Dashboard Route
router.get("/doctor-dashboard/:id", authDoctor, async (req, res) => {
  try {
    const requestedId = req.params.id;
    const authenticatedUserId = req.user.id;

    if (requestedId !== authenticatedUserId || requestedId === "undefined") {
      return res.status(403).json({ error: "Unauthorized: You can only access your own dashboard" });
    }

    const doctor = await Doctor.findById(authenticatedUserId).select("-password");
    if (!doctor) {
      return res.status(404).json({ error: "Doctor not found" });
    }

    const appointments = await Appointment.find({ doctorId: authenticatedUserId });

    res.json({
      id: doctor._id,
      name: doctor.name,
      email: doctor.email,
      specialization: doctor.specialization,
      consultationFee: doctor.consultationFee,
      availability: doctor.availability,
      appointments,
    });
  } catch (error) {
    console.error("Error in doctor dashboard:", error.stack);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Get all doctors
router.get("/", async (req, res) => {
  const { state, city } = req.query;
  try {
    const query = {};
    if (state) query.state = state;
    if (city) query.city = city;
    const doctors = await Doctor.find(query).select("-password");
    res.json(doctors);
  } catch (error) {
    console.error("Error fetching doctors:", error.stack);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Search doctors (only verified)
// Search doctors (only verified) - FIXED TO INCLUDE profilePicture
// Search doctors (only verified) - Updated to include average rating
// Search doctors (only verified)
router.get("/search", async (req, res) => {
  console.log('Received request for /api/doctors/search with query:', req.query);
  try {
    const { state, city, specialization, name } = req.query;
    const query = { isVerified: true };
    if (state && city) {
      query.state = state;
      query.city = city;
    }
    if (specialization) query.specialization = specialization;
    if (name) query.name = { $regex: name, $options: "i" };

    const doctors = await Doctor.find(query).select("-password -token -refreshToken -__v");

    const doctorsWithRatings = await Promise.all(
      doctors.map(async (doctor) => {
        const feedback = await Feedback.aggregate([
          { $match: { doctorId: doctor._id } },
          { $group: { _id: "$doctorId", averageRating: { $avg: "$rating" } } },
        ]);

        const averageRating = feedback.length > 0 ? feedback[0].averageRating : 0;
        console.log(`Doctor ${doctor.name} availability:`, doctor.availability);

        // Convert availability to plain object
        const availabilityObj = {};
        daysOfWeek.forEach(day => {
          const slots = doctor.availability[day] || doctor.availability.get && doctor.availability.get(day) || [];
          availabilityObj[day] = Array.isArray(slots) ? slots : [];
        });

        return {
          ...doctor.toObject(),
          availability: availabilityObj, // Explicitly set availability
          averageRating: Number(averageRating.toFixed(1)),
        };
      })
    );

    console.log('Doctors found with ratings:', doctorsWithRatings);
    res.status(200).json(doctorsWithRatings);
  } catch (error) {
    console.error("Error searching doctors:", error.stack);
    res.status(500).json({ error: "Failed to search doctors", details: error.message });
  }
});

// Get doctor profile
router.get("/profile", authDoctor, async (req, res) => {
  try {
    const doctor = await Doctor.findById(req.user.id).select("-password");
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });
    res.status(200).json(doctor);
  } catch (error) {
    console.error("Error fetching doctor profile:", error.stack);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// Update doctor profile
// Update doctor profile (with profile picture)
router.put("/profile", authDoctor, upload.single('profilePicture'), async (req, res) => {
  try {
    const updates = req.body;

    if (updates.availability) {
      updates.availability = typeof updates.availability === 'string' 
        ? JSON.parse(updates.availability) 
        : updates.availability;
      const normalizedAvailability = {};
      daysOfWeek.forEach((day) => {
        normalizedAvailability[day] = Array.isArray(updates.availability[day])
          ? updates.availability[day]
          : [];
      });
      updates.availability = normalizedAvailability;
    }

    if (req.file) {
      const profilePicUrl = await uploadToSupabase(req.file, 'profile-pictures');
      updates.profilePicture = profilePicUrl;
    }

    console.log('Updates to apply:', updates);
    const updatedDoctor = await Doctor.findByIdAndUpdate(
      req.user.id,
      { $set: updates },
      { new: true, select: "-password", runValidators: true }
    );

    if (!updatedDoctor) return res.status(404).json({ error: "Doctor not found" });
    console.log('Updated Doctor from DB:', updatedDoctor);
    res.status(200).json(updatedDoctor);
  } catch (error) {
    console.error("Error updating doctor profile:", error.stack);
    res.status(500).json({ error: "Internal server error", details: error.message });
  }
});

// Get doctor availability
router.get("/:doctorId/availability", async (req, res) => {
  const { doctorId } = req.params;
  let { day } = req.query;
  day = day.charAt(0).toUpperCase() + day.slice(1).toLowerCase();
  try {
    const doctor = await Doctor.findById(doctorId).select("availability");
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });
    const slots = doctor.availability.get(day) || [];
    res.json({ [day]: slots });
  } catch (error) {
    console.error("Error fetching doctor availability:", error.stack);
    res.status(500).json({ error: "Server error", details: error.message });
  }
});

// Get patient history (prescriptions) for a doctor
router.get("/appointments/patient/:patientId/history", authDoctor, async (req, res) => {
  try {
    const prescriptions = await Prescription.find({ patientId: req.params.patientId });
    const prescriptionsWithDoctor = await Promise.all(
      prescriptions.map(async (pres) => {
        const doctor = await Doctor.findById(pres.doctorId);
        return {
          ...pres._doc,
          createdAt: pres.createdAt || new Date(),
          doctorName: doctor ? doctor.name : "Unknown Doctor",
        };
      })
    );
    res.json({ prescriptions: prescriptionsWithDoctor });
  } catch (err) {
    console.error("Fetch patient history error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Earnings Overview
// Earnings Overview
// Earnings Overview
router.get("/earnings/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    const appointments = await Appointment.find({ doctorId, status: "completed" });

    // Calculate earnings using stored commission rates
    const totalEarnings = appointments.reduce((sum, app) => sum + (app.consultationFee || 0), 0);
    const netEarnings = appointments.reduce((sum, app) => {
      const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
      return sum + (app.consultationFee || 0) - doctorCommission;
    }, 0);

    const withdrawals = await Withdrawal.find({ doctorId });
    const totalWithdrawn = withdrawals
      .filter((w) => w.status === "approved")
      .reduce((sum, w) => sum + w.amount, 0);
    const totalAmountAvailableForWithdrawal = netEarnings - totalWithdrawn;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Update todaysEarnings to use completedAt instead of date
    const todaysEarnings = appointments
      .filter((app) => {
        if (!app.completedAt) return false; // Skip if completedAt is not set
        const completedDate = new Date(app.completedAt);
        completedDate.setHours(0, 0, 0, 0);
        return completedDate.toDateString() === today.toDateString();
      })
      .reduce((sum, app) => {
        const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
        return sum + (app.consultationFee || 0) - doctorCommission;
      }, 0);

    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 7);
    const monthAgo = new Date(today);
    monthAgo.setMonth(today.getMonth() - 1);
    const yearAgo = new Date(today);
    yearAgo.setFullYear(today.getFullYear() - 1);

    const previousEarnings = {
      weekly: appointments
        .filter((app) => {
          if (!app.completedAt) return false;
          const completedDate = new Date(app.completedAt);
          return completedDate >= weekAgo && completedDate < today;
        })
        .reduce((sum, app) => {
          const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
          return sum + (app.consultationFee || 0) - doctorCommission;
        }, 0),
      monthly: appointments
        .filter((app) => {
          if (!app.completedAt) return false;
          const completedDate = new Date(app.completedAt);
          return completedDate >= monthAgo && completedDate < today;
        })
        .reduce((sum, app) => {
          const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
          return sum + (app.consultationFee || 0) - doctorCommission;
        }, 0),
      yearly: appointments
        .filter((app) => {
          if (!app.completedAt) return false;
          const completedDate = new Date(app.completedAt);
          return completedDate >= yearAgo && completedDate < today;
        })
        .reduce((sum, app) => {
          const doctorCommission = (app.doctorCommissionRate / 100) * (app.consultationFee || 0);
          return sum + (app.consultationFee || 0) - doctorCommission;
        }, 0),
    };

    const nextPayoutDate = new Date();
    nextPayoutDate.setDate(nextPayoutDate.getDate() + ((1 + 7 - nextPayoutDate.getDay()) % 7 || 7));
    nextPayoutDate.setHours(0, 0, 0, 0);

    res.json({
      todaysEarnings,
      previousEarnings,
      totalEarnings: netEarnings,
      totalAmountAvailableForWithdrawal,
      totalWithdrawn,
      nextPayoutDate: nextPayoutDate.toISOString().split("T")[0],
    });
  } catch (err) {
    console.error("Earnings fetch error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Earnings Breakdown
router.get("/earnings/breakdown/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    const appointments = await Appointment.find({ doctorId, status: "completed" }).populate(
      "patientId",
      "name state city"
    );

    const breakdown = appointments.map((app) => {
      const baseFee = app.consultationFee || 0;
      const commission = baseFee * (app.doctorCommissionRate / 100); // Use stored rate
      const netEarnings = baseFee - commission;

      return {
        appointmentId: app._id.toString(),
        date: app.date,
        patientName: app.patientId?.name || "Unknown",
        state: app.patientId?.state || "Unknown",
        city: app.patientId?.city || "Unknown",
        fee: baseFee,
        commission,
        netEarnings,
        status: app.paymentStatus === "paid" ? "paid" : "pending",
      };
    });

    res.json(breakdown);
  } catch (err) {
    console.error("Earnings breakdown fetch error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Withdrawal History
router.get("/withdrawals/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    const withdrawals = await Withdrawal.find({ doctorId });
    res.json(withdrawals);
  } catch (err) {
    console.error("Withdrawal history fetch error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Request Withdrawal
router.post("/withdrawals/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const { amount } = req.body;
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    // Check if bank details are missing
    if (!doctor.bankDetails?.accountNumber && !doctor.bankDetails?.upiId) {
      return res.status(400).json({ 
        error: "Bank details required",
        action: "updateBankDetails" // Added for frontend to identify this specific error
      });
    }

    const appointments = await Appointment.find({ doctorId, status: "completed" });
    const settings = await PlatformSettings.findOne() || { doctorCommission: 10 };
    const commissionRate = settings.doctorCommission / 100;
    const totalEarnings = appointments.reduce((sum, app) => sum + (app.consultationFee || 0), 0);
    const netEarnings = totalEarnings * (1 - commissionRate);
    const withdrawals = await Withdrawal.find({ doctorId });
    const totalWithdrawn = withdrawals
      .filter((w) => w.status === "approved")
      .reduce((sum, w) => sum + w.amount, 0);
    const currentBalance = netEarnings - totalWithdrawn;

    if (amount > currentBalance || amount < 1000) {
      return res.status(400).json({
        error: `Invalid withdrawal amount. Must be between ₹1000 and ₹${currentBalance}`,
      });
    }

    const withdrawal = new Withdrawal({
      doctorId,
      amount,
      requestDate: new Date(),
      status: "pending",
      method: doctor.bankDetails.upiId ? "UPI" : "Bank Transfer",
    });
    await withdrawal.save();

    res.status(201).json({ message: "Withdrawal request submitted", withdrawal });
  } catch (err) {
    console.error("Withdrawal request error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Bank Details - GET
router.get("/bank-details/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    res.json(
      doctor.bankDetails || {
        accountHolderName: "",
        bankName: "",
        branchName: "",
        accountNumber: "",
        confirmAccountNumber: "",
        ifscCode: "",
        upiId: "",
        paytmNumber: "",
        googlePayNumber: "",
        phonePeNumber: "",
      }
    );
  } catch (err) {
    console.error("Bank details fetch error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Bank Details - PUT
router.put("/bank-details/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const {
      accountHolderName,
      bankName,
      branchName,
      accountNumber,
      confirmAccountNumber,
      ifscCode,
      upiId,
      paytmNumber,
      googlePayNumber,
      phonePeNumber,
    } = req.body;

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    if (!doctor.bankDetails) {
      doctor.bankDetails = {
        accountHolderName: "",
        bankName: "",
        branchName: "",
        accountNumber: "",
        confirmAccountNumber: "",
        ifscCode: "",
        upiId: "",
        paytmNumber: "",
        googlePayNumber: "",
        phonePeNumber: "",
      };
    }

    if (accountNumber && confirmAccountNumber && accountNumber !== confirmAccountNumber) {
      return res.status(400).json({ error: "Account numbers do not match" });
    }
    if (accountNumber && !/^\d{9,18}$/.test(accountNumber)) {
      return res.status(400).json({ error: "Invalid account number (must be 9-18 digits)" });
    }
    if (ifscCode && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifscCode)) {
      return res.status(400).json({ error: "Invalid IFSC code (e.g., SBIN0001234)" });
    }
    if (upiId && !/^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z]{2,64}$/.test(upiId)) {
      return res.status(400).json({ error: "Invalid UPI ID (e.g., user@upi)" });
    }
    if (paytmNumber && !/^\d{10}$/.test(paytmNumber)) {
      return res.status(400).json({ error: "Invalid Paytm number (must be 10 digits)" });
    }
    if (googlePayNumber && !/^\d{10}$/.test(googlePayNumber)) {
      return res.status(400).json({ error: "Invalid Google Pay number (must be 10 digits)" });
    }
    if (phonePeNumber && !/^\d{10}$/.test(phonePeNumber)) {
      return res.status(400).json({ error: "Invalid PhonePe number (must be 10 digits)" });
    }

    doctor.bankDetails.accountHolderName =
      accountHolderName !== undefined ? accountHolderName : doctor.bankDetails.accountHolderName;
    doctor.bankDetails.bankName = bankName !== undefined ? bankName : doctor.bankDetails.bankName;
    doctor.bankDetails.branchName =
      branchName !== undefined ? branchName : doctor.bankDetails.branchName;
    doctor.bankDetails.accountNumber =
      accountNumber !== undefined ? accountNumber : doctor.bankDetails.accountNumber;
    doctor.bankDetails.confirmAccountNumber =
      confirmAccountNumber !== undefined
        ? confirmAccountNumber
        : doctor.bankDetails.confirmAccountNumber;
    doctor.bankDetails.ifscCode = ifscCode !== undefined ? ifscCode : doctor.bankDetails.ifscCode;
    doctor.bankDetails.upiId = upiId !== undefined ? upiId : doctor.bankDetails.upiId;
    doctor.bankDetails.paytmNumber =
      paytmNumber !== undefined ? paytmNumber : doctor.bankDetails.paytmNumber;
    doctor.bankDetails.googlePayNumber =
      googlePayNumber !== undefined ? googlePayNumber : doctor.bankDetails.googlePayNumber;
    doctor.bankDetails.phonePeNumber =
      phonePeNumber !== undefined ? phonePeNumber : doctor.bankDetails.phonePeNumber;

    await doctor.save();
    res.json({ message: "Bank details updated", bankDetails: doctor.bankDetails });
  } catch (err) {
    console.error("Bank details update error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Financial Analytics
router.get("/analytics/:id", authDoctor, async (req, res) => {
  try {
    const doctorId = req.params.id;
    if (doctorId !== req.user.id) return res.status(403).json({ error: "Unauthorized" });

    const doctor = await Doctor.findById(doctorId);
    if (!doctor) return res.status(404).json({ error: "Doctor not found" });

    const appointments = await Appointment.find({ doctorId, status: "completed" }).populate(
      "patientId",
      "name state city"
    );
    const settings = await PlatformSettings.findOne() || { doctorCommission: 10 };
    const commissionRate = settings.doctorCommission / 100;

    const dailyEarningsMap = {};
    appointments.forEach((app) => {
      const date = new Date(app.date).toLocaleDateString();
      dailyEarningsMap[date] =
        (dailyEarningsMap[date] || 0) + (app.consultationFee || 0) * (1 - commissionRate);
    });
    const dailyEarnings = Object.entries(dailyEarningsMap).map(([date, earnings]) => ({
      date,
      earnings,
    }));

    const weeklyEarningsMap = {};
    appointments.forEach((app) => {
      const weekStart = new Date(app.date);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const period = weekStart.toLocaleDateString();
      weeklyEarningsMap[period] =
        (weeklyEarningsMap[period] || 0) + (app.consultationFee || 0) * (1 - commissionRate);
    });
    const weeklyEarnings = Object.entries(weeklyEarningsMap).map(([period, earnings]) => ({
      period,
      earnings,
    }));

    const monthlyEarningsMap = {};
    appointments.forEach((app) => {
      const period = new Date(app.date).toLocaleString("default", { month: "short", year: "numeric" });
      monthlyEarningsMap[period] =
        (monthlyEarningsMap[period] || 0) + (app.consultationFee || 0) * (1 - commissionRate);
    });
    const monthlyEarnings = Object.entries(monthlyEarningsMap).map(([period, earnings]) => ({
      period,
      earnings,
    }));

    const locationEarnings = {};
    appointments.forEach((app) => {
      const key = `${app.patientId?.state || "Unknown"}, ${app.patientId?.city || "Unknown"}`;
      locationEarnings[key] =
        (locationEarnings[key] || 0) + (app.consultationFee || 0) * (1 - commissionRate);
    });
    const earningsByLocation = Object.entries(locationEarnings)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([location, earnings]) => {
        const [state, city] = location.split(", ");
        return { state, city, earnings };
      });

    const typeEarnings = {};
    appointments.forEach((app) => {
      const type = app.type || "Video Consultation";
      typeEarnings[type] =
        (typeEarnings[type] || 0) + (app.consultationFee || 0) * (1 - commissionRate);
    });
    const earningsByAppointmentType = Object.entries(typeEarnings).map(([type, earnings]) => ({
      type,
      earnings,
    }));

    res.json({
      dailyEarnings,
      weeklyEarnings,
      monthlyEarnings,
      topCities: earningsByLocation,
      earningsByLocation,
      earningsByAppointmentType,
    });
  } catch (err) {
    console.error("Analytics fetch error:", err.stack);
    res.status(500).json({ error: "Server error", details: err.message });
  }
});

// Invoice Download (Placeholder)
// Invoice Download
// Invoice Download
// Invoice Download
router.get('/invoice/:withdrawalId', authDoctor, async (req, res) => {
  try {
    const withdrawalId = req.params.withdrawalId;
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal || withdrawal.doctorId.toString() !== req.user.id) {
      return res.status(403).json({ error: 'Unauthorized or withdrawal not found' });
    }

    if (!withdrawal.invoicePath) {
      return res.status(404).json({ error: 'No invoice available for this withdrawal' });
    }

    // Ensure B2 is initialized
    if (!b2BucketId) {
      await initializeB2();
    }

    // Get the file name from the withdrawal
    const fileName = withdrawal.invoicePath.replace(`${process.env.B2_BUCKET_NAME}/`, ''); // e.g., "invoices/withdrawal_67ebf157874f55917393e7b2.pdf"

    // Download the file from Backblaze B2
    await b2.authorize(); // Ensure authorization is fresh
    const downloadResponse = await b2.downloadFileByName({
      bucketName: process.env.B2_BUCKET_NAME,
      fileName: fileName,
      responseType: 'stream', // Stream the file
    });

    // Set headers to force download
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice_${withdrawalId}.pdf"`);

    // Pipe the file stream to the response
    downloadResponse.data.pipe(res);

    downloadResponse.data.on('end', () => {
      console.log(`Invoice ${withdrawalId} streamed successfully`);
    });

    downloadResponse.data.on('error', (err) => {
      console.error('Stream error:', err);
      res.status(500).json({ error: 'Failed to stream invoice', details: err.message });
    });

  } catch (err) {
    console.error('Invoice fetch error:', err.stack);
    res.status(500).json({ error: 'Server error', details: err.message });
  }
});

// Doctor Change Password
router.post('/doctor/change-password', authDoctor, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  try {
    const doctor = await Doctor.findById(req.user.id);
    if (!doctor) return res.status(404).json({ error: 'Doctor not found' });

    const isMatch = await doctor.matchPassword(currentPassword);
    if (!isMatch) return res.status(400).json({ error: 'Current password is incorrect' });

    doctor.password = newPassword; // pre-save hook will hash it
    await doctor.save();

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    console.error('Error in doctor change password:', error.stack);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;