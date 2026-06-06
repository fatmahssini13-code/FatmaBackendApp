const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  
  role: {
    type: String,
    enum: ["client", "freelancer", "admin"],
    required: true
  },

  // --- CHAMPS SPÉCIFIQUES FREELANCER ---
  speciality: { type: String },
  skills: [String],
  bio: { type: String },
  hourlyRate: { type: Number },
  languages: [String],

  // --- CHAMPS SPÉCIFIQUES CLIENT ---
  companyName: { type: String },
  location: { type: String },

  // --- SOCIAL LINKS ---
  website: { type: String, default: "" },
  linkedin: { type: String, default: "" },
  github: { type: String, default: "" },

  // --- WALLET ---
  walletBalance: { type: Number, default: 0 },
  processedWalletTopUpIntentIds: { type: [String], default: [] },
  walletLedger: [
    {
      type: {
        type: String,
        enum: ["topup", "project_funding", "refund"],
        required: true,
      },
      amount: { type: Number, required: true },
      label: { type: String, default: "" },
      refId: { type: String, default: "" },
      createdAt: { type: Date, default: Date.now },
    },
  ],

  // --- PARAMÈTRES COMMUNS ---
  avatar: { type: String, default: "" },
  phoneNumber: { type: String },
  isVerified: { type: Boolean, default: false },
  isBlocked: { type: Boolean, default: false },
  isArchived: { type: Boolean, default: false },
  archivedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.models.User || mongoose.model("User", userSchema);
