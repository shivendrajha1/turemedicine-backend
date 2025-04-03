require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const { authDoctor } = require("./middlewares/authMiddleware");

const Doctor = require("./models/Doctor");
const Patient = require("./models/Patient");
const Admin = require("./models/Admin");

const doctorRoutes = require("./routes/doctorRoutes");
const appointmentRoutes = require("./routes/appointmentRoutes");
const notificationRoutes = require("./routes/notification");
const patientRoutes = require("./routes/patient");
const authRoutes = require("./routes/authRoutes");
const feedbackRoutes = require("./routes/feedback");
const prescriptionRoutes = require("./routes/prescription");
const adminRoutes = require("./routes/adminroutes");

// Log critical environment variables (mask sensitive parts in production)
console.log("MONGO_URI:", process.env.MONGO_URI ? "Set" : "Not set");
console.log("FRONTEND_URL:", process.env.FRONTEND_URL || "Not set");
console.log("RAZORPAY_KEY_ID:", process.env.RAZORPAY_KEY_ID ? "Set" : "Not set");
console.log("RAZORPAY_KEY_SECRET:", process.env.RAZORPAY_KEY_SECRET ? "Set" : "Not set");

// Firebase initialization
const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY,
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
  universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
};

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("Firebase Admin SDK initialized successfully");
} catch (err) {
  console.error("Failed to initialize Firebase Admin SDK:", err.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 5000; // Use Render's PORT or fallback to 5000
const HOST = "0.0.0.0";

const FRONTEND_URL = process.env.FRONTEND_URL || "https://turemedicine.com";
const ALLOWED_ORIGINS = [
  "https://turemedicine.com",
  "https://localhost:3000",
  "http://localhost:3000",
];

app.use(cors({
  origin: ALLOWED_ORIGINS,
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
  allowedHeaders: ["Content-Type", "Authorization"],
}));
app.use(express.json());
app.use("/uploads", express.static("uploads"));

// Create HTTP server (Render handles SSL)
const server = app.listen(PORT, HOST, () => {
  console.log(`Server running on http://${HOST}:${PORT}`);
});

const io = new Server(server, {
  cors: {
    origin: ALLOWED_ORIGINS,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  },
  transports: ["websocket"],
  path: "/socket.io",
  pingTimeout: 60000,
  pingInterval: 25000,
});

const seedSuperAdmin = async () => {
  try {
    const superAdminExists = await Admin.findOne({ email: "Shivendra1235@example.com" });
    if (!superAdminExists) {
      const superAdmin = new Admin({
        name: "Shivendra",
        email: "Shivendra1235@example.com",
        password: "Shivendra1235",
        role: "Super Admin",
        isInitialSuperAdmin: true,
      });
      await superAdmin.save();
      console.log("Initial Super Admin seeded: Shivendra1235@example.com");
    } else if (!superAdminExists.isInitialSuperAdmin) {
      await Admin.updateOne(
        { email: "Shivendra1235@example.com" },
        { $set: { isInitialSuperAdmin: true } }
      );
      console.log("Existing Super Admin updated with isInitialSuperAdmin flag");
    } else {
      console.log("Initial Super Admin already exists");
    }
  } catch (err) {
    console.error("Error seeding Super Admin:", err.message);
  }
};

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("MongoDB Connected");
    await seedSuperAdmin();
  } catch (err) {
    console.error("MongoDB Connection Error:", err.message);
    process.exit(1);
  }
};

connectDB();

const consultations = {};

io.on("connection", (socket) => {
  const { userType, appointmentId } = socket.handshake.query;
  console.log("New socket connection:", {
    id: socket.id,
    userType,
    appointmentId,
    address: socket.handshake.address,
    time: new Date().toISOString(),
  });

  socket.on("join consultation", ({ appointmentId, userType }) => {
    if (!consultations[appointmentId]) {
      consultations[appointmentId] = {
        active: false,
        participants: {},
        initiator: null,
        startTime: new Date(),
        pendingOffer: null,
      };
    }
    consultations[appointmentId].participants[userType] = socket.id;
    socket.join(appointmentId);
    console.log(`${userType} joined consultation ${appointmentId}:`, consultations[appointmentId]);

    const otherUserType = userType === "doctor" ? "patient" : "doctor";
    if (!consultations[appointmentId].initiator) {
      consultations[appointmentId].initiator = userType;
      socket.emit("start negotiation", { role: "initiator" });
      console.log(`${userType} is the initiator for ${appointmentId}`);
    } else {
      socket.emit("start negotiation", { role: "responder" });
    }

    if (consultations[appointmentId].participants[otherUserType]) {
      io.to(consultations[appointmentId].participants[otherUserType]).emit("user joined", { userType });
      if (consultations[appointmentId].pendingOffer) {
        io.to(socket.id).emit("offer", consultations[appointmentId].pendingOffer);
        consultations[appointmentId].pendingOffer = null;
        console.log(`Delivered pending offer to ${userType} for ${appointmentId}`);
      }
      console.log(`Notifying ${otherUserType} of ${userType} joining ${appointmentId}`);
    }
  });

  socket.on("offer", ({ appointmentId, offer }) => {
    const senderType = consultations[appointmentId]?.participants.doctor === socket.id ? "doctor" : "patient";
    const targetType = senderType === "doctor" ? "patient" : "doctor";
    const targetSocketId = consultations[appointmentId]?.participants[targetType];
    if (targetSocketId) {
      io.to(targetSocketId).emit("offer", { offer, from: senderType });
      consultations[appointmentId].active = true;
      console.log(`Offer from ${senderType} sent to ${targetType} for ${appointmentId}`);
    } else {
      consultations[appointmentId].pendingOffer = { offer, from: senderType };
      console.log(`Stored pending offer from ${senderType} for ${appointmentId}`);
    }
  });

  socket.on("answer", ({ appointmentId, answer }) => {
    const senderType = consultations[appointmentId]?.participants.doctor === socket.id ? "doctor" : "patient";
    const targetType = senderType === "doctor" ? "patient" : "doctor";
    const targetSocketId = consultations[appointmentId]?.participants[targetType];
    if (targetSocketId) {
      io.to(targetSocketId).emit("answer", { answer, from: senderType });
      consultations[appointmentId].active = true;
      console.log(`Answer from ${senderType} sent to ${targetType} for ${appointmentId}`);
    } else {
      console.log(`Target ${targetType} not found for ${appointmentId}`);
    }
  });

  socket.on("ice-candidate", ({ appointmentId, candidate }) => {
    const senderType = consultations[appointmentId]?.participants.doctor === socket.id ? "doctor" : "patient";
    const targetType = senderType === "doctor" ? "patient" : "doctor";
    const targetSocketId = consultations[appointmentId]?.participants[targetType];
    if (targetSocketId) {
      io.to(targetSocketId).emit("ice-candidate", candidate);
      console.log(`ICE candidate from ${senderType} sent to ${targetType} for ${appointmentId}`);
    }
  });

  socket.on("end call", ({ appointmentId }) => {
    if (consultations[appointmentId]?.active) {
      const endTime = new Date();
      const durationMs = consultations[appointmentId].startTime ? endTime - consultations[appointmentId].startTime : 0;
      const durationSeconds = Math.floor(durationMs / 1000);
      const minutes = Math.floor(durationSeconds / 60);
      const seconds = durationSeconds % 60;
      const formattedDuration = `${minutes}m ${seconds}s`;

      io.to(appointmentId).emit("call ended", { duration: formattedDuration });
      delete consultations[appointmentId];
      console.log(`Call ended for ${appointmentId}. Duration: ${formattedDuration}`);
    }
  });

  socket.on("disconnect", (reason) => {
    console.log("Socket disconnected:", socket.id, "Reason:", reason);
    for (const appointmentId in consultations) {
      const consultation = consultations[appointmentId];
      if (consultation.participants.doctor === socket.id || consultation.participants.patient === socket.id) {
        const userType = consultation.participants.doctor === socket.id ? "doctor" : "patient";
        delete consultation.participants[userType];
        io.to(appointmentId).emit("user disconnected", { userType });
        console.log(`${userType} disconnected from ${appointmentId}, notifying remaining participants`);

        if (Object.keys(consultation.participants).length > 0) {
          io.to(appointmentId).emit("rejoin consultation", { appointmentId, userType });
          if (consultation.active) {
            setTimeout(() => {
              if (consultation && Object.keys(consultation.participants).length < 2) {
                const endTime = new Date();
                const durationMs = consultation.startTime ? endTime - consultation.startTime : 0;
                const durationSeconds = Math.floor(durationMs / 1000);
                const minutes = Math.floor(durationSeconds / 60);
                const seconds = durationSeconds % 60;
                const formattedDuration = `${minutes}m ${seconds}s`;
                io.to(appointmentId).emit("call ended", { duration: formattedDuration });
                delete consultations[appointmentId];
                console.log(`Call ended for ${appointmentId} after timeout. Duration: ${formattedDuration}`);
              }
            }, 30000); // Wait 30 seconds
          }
        } else {
          delete consultations[appointmentId];
          console.log(`Consultation ${appointmentId} deleted as all participants disconnected`);
        }
      }
    }
  });
});

app.use("/auth", authRoutes);
app.use("/patients", patientRoutes);
app.use("/doctors", doctorRoutes);
app.use("/appointments", appointmentRoutes);
app.use("/notifications", notificationRoutes);
app.use("/feedback", feedbackRoutes);
app.use("/prescriptions", prescriptionRoutes);
app.use("/admin", adminRoutes);

app.get("/health-tips", (req, res) => res.status(200).json([]));
app.get("/recommendations", (req, res) => res.status(200).json([]));
app.get("/", (req, res) => res.send("Welcome to the Telemedicine API"));

app.post("/start-consultation", authDoctor, async (req, res) => {
  const { doctorId, patientId, appointmentId } = req.body;
  console.log(`Received /start-consultation request:`, { doctorId, patientId, appointmentId });

  try {
    const doctor = await Doctor.findById(doctorId);
    if (!doctor) {
      console.log(`Doctor not found for ID: ${doctorId}`);
      return res.status(404).json({ error: "Doctor not found" });
    }

    let patient = await Patient.findById(patientId);
    if (!patient) {
      console.log(`Patient not found for ID: ${patientId}`);
      return res.status(404).json({ error: "Patient not found" });
    }

    // Initialize pushTokens if undefined
    if (!patient.pushTokens) {
      patient.pushTokens = [];
      await patient.save();
    }

    // Log patient data
    console.log(`Patient data fetched for ${patientId}:`, { pushTokens: patient.pushTokens });

    const message = {
      notification: {
        title: "Consultation Started",
        body: `${doctor.name} has started your consultation. Please join now.`,
      },
      data: {
        appointmentId,
        doctorName: doctor.name,
        click_action: `${FRONTEND_URL}/patient/video-call/${appointmentId}`,
      },
    };

    let notificationSent = false;
    if (patient.pushTokens.length > 0) {
      for (const pushToken of patient.pushTokens) {
        message.token = pushToken;
        console.log(`Sending FCM notification to patient ${patientId} with token: ${pushToken}`);
        try {
          const response = await admin.messaging().send(message);
          console.log(`FCM notification sent successfully to ${pushToken}:`, response);
          notificationSent = true;
        } catch (fcmError) {
          console.error(`FCM send failed for token ${pushToken}:`, {
            message: fcmError.message,
            code: fcmError.code,
            details: fcmError.details,
          });
          if (fcmError.code === "messaging/registration-token-not-registered") {
            patient.pushTokens = patient.pushTokens.filter((t) => t !== pushToken);
            await patient.save();
            console.log(`Removed invalid token ${pushToken} for patient ${patientId}`);
          }
        }
      }
    } else {
      console.log(`No push tokens available for patient ${patientId}`);
    }

    // Always return success, even if no notification is sent
    res.status(200).json({
      message: notificationSent
        ? "Consultation started and notification sent"
        : "Consultation started, but no valid push tokens available",
      appointmentId,
      doctorName: doctor.name,
    });
  } catch (err) {
    console.error(`Error in /start-consultation for patient ${patientId}:`, err.message);
    res.status(500).json({ error: "Failed to start consultation", details: err.message });
  }
});

app.post("/patients/register-push-token", async (req, res) => {
  const { patientId, token, overwrite } = req.body;
  console.log(`Registering push token for patient ${patientId}: ${token}`);

  try {
    const patient = await Patient.findById(patientId);
    if (!patient) {
      console.log(`Patient not found for ID: ${patientId}`);
      return res.status(404).json({ error: "Patient not found" });
    }

    if (!patient.pushTokens) patient.pushTokens = [];

    if (overwrite) {
      patient.pushTokens = [token];
    } else {
      if (!patient.pushTokens.includes(token)) {
        patient.pushTokens.push(token);
      }
    }
    await patient.save();
    console.log(`Push token updated for patient ${patientId}: ${patient.pushTokens}`);
    res.status(200).json({ message: "Push token registered", patient });
  } catch (err) {
    console.error(`Error registering push token:`, err.message);
    res.status(500).json({ error: "Failed to register push token", details: err.message });
  }
});

app.use((err, req, res, next) => {
  console.error("Server Error:", err.stack);
  res.status(500).json({ error: "Internal Server Error", details: err.message });
});
