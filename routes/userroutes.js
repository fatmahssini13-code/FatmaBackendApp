const router = require("express").Router();
const User = require("../models/User");
const Project = require("../models/project");
const bcrypt = require("bcrypt");
const { requireAuth } = require("../middleware/authMiddleware");
const { uploadAvatar } = require("../config/cloudinary");
const { findUserByEmailParam } = require("../utils/userEmailLookup");
const {
  ensureClientWalletLedger,
  formatLedgerForApi,
} = require("../utils/walletLedger");

// --- 1. GET PROFIL ---
router.get("/profile/:email", async (req, res) => {
  try {
    const user = await findUserByEmailParam(req.params.email);
    if (!user) return res.status(404).json({ message: "Utilisateur non trouvé" });

    let userData = {
      id: user._id,
      name: user.name,
      displayName: user.name || user.email.split("@")[0],
      email: user.email,
      role: user.role,
      avatar: user.avatar || null,
      bio: user.bio || "",
      createdAt: user.createdAt,
    };

    if (user.role === "client") {
      userData.companyName = user.companyName || "Particulier";
      userData.projectCount = await Project.countDocuments({
        owner: user._id,
      });
    }

    if (user.role === "freelancer") {
      const Proposal = require("../models/proposal");
      userData.speciality = user.speciality || "Freelancer";
      userData.skills = user.skills || [];
      userData.proposalCount = await Proposal.countDocuments({
        freelancer: user._id,
      });
      userData.wonCount = await Proposal.countDocuments({
        freelancer: user._id,
        status: "accepted",
      });
    }

    res.status(200).json(userData);
  } catch (err) {
    res.status(500).json({ message: "Erreur serveur", error: err.message });
  }
});

// --- 2. UPDATE PROFIL ---
router.put("/update/:email", async (req, res) => {
  try {
    const user = await findUserByEmailParam(req.params.email);
    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    const { name, bio, companyName, speciality, location, website, linkedin, github, hourlyRate } = req.body || {};

    if (name != null) {
      const trimmed = String(name).trim();
      if (!trimmed) {
        return res.status(400).json({ message: "Le nom ne peut pas être vide" });
      }
      user.name = trimmed;
    }
    if (bio != null) user.bio = String(bio).trim();
    if (location != null) user.location = String(location).trim();
    if (website != null) user.website = String(website).trim();
    if (linkedin != null) user.linkedin = String(linkedin).trim();
    if (github != null) user.github = String(github).trim();
    if (companyName != null && user.role === "client") {
      user.companyName = String(companyName).trim();
    }
    if (speciality != null && user.role === "freelancer") {
      user.speciality = String(speciality).trim();
    }
    if (hourlyRate != null && user.role === "freelancer") {
      user.hourlyRate = Number(hourlyRate);
    }

    await user.save();

    res.status(200).json({
      message: "Profil mis à jour avec succès ✅",
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        bio: user.bio || "",
        avatar: user.avatar || null,
        location: user.location || "",
        website: user.website || "",
        linkedin: user.linkedin || "",
        github: user.github || "",
        hourlyRate: user.hourlyRate || null,
        companyName: user.companyName,
        speciality: user.speciality,
      },
    });
  } catch (err) {
    res.status(500).json({ message: "Erreur lors de la mise à jour", error: err.message });
  }
});

// --- 3. ALL FREELANCERS ---
router.get("/all-freelancers", async (req, res) => {
  try {
    const freelancers = await User.find({ role: "freelancer" }).select(
      "name email speciality skills bio avatar"
    );
    res.status(200).json(freelancers);
  } catch (err) {
    res.status(500).json({ message: "Erreur récupération freelancers", error: err });
  }
});

// --- 4. CHANGE PASSWORD ---
router.put("/change-password/:email", async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    const user = await findUserByEmailParam(req.params.email);

    if (!user) return res.status(404).json({ message: "Utilisateur non trouvé" });

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) return res.status(400).json({ message: "Ancien mot de passe incorrect" });

    user.password = await bcrypt.hash(newPassword, 10);
    await user.save();

    res.json({ message: "Mot de passe modifié ✅" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// --- 5. UPLOAD AVATAR ---
router.post("/upload-avatar/:email", uploadAvatar.single("avatar"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Aucun fichier reçu" });
    }

    // Cloudinary returns the public URL in req.file.path
    const avatarUrl = req.file.path;

    const user = await findUserByEmailParam(req.params.email);
    if (!user) {
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }
    user.avatar = avatarUrl;
    await user.save();

    console.log(`✅ Avatar uploadé : ${avatarUrl}`);
    res.json({ avatarUrl });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});
router.get("/wallet", requireAuth, async (req, res) => {
  try {
    let user = await User.findById(req.user._id).select(
      "walletBalance role walletLedger processedWalletTopUpIntentIds"
    );
    if (!user) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }
    const balance = user.walletBalance ?? 0;
    if (user.role === "freelancer") {
      const projects = await Project.find({
        acceptedFreelancer: req.user._id,
        status: "completed"
      })
        .select("title budget createdAt")
        .sort({ createdAt: -1 });
      return res.json({
        balance,
        currency: "EUR",
        projectCount: projects.length,
        transactions: projects
      });
    }

    if (user.role === "client") {
      user = await ensureClientWalletLedger(user);
      const projectCount = await Project.countDocuments({
        owner: req.user._id,
      });
      const transactions = formatLedgerForApi(user.walletLedger);
      const totalTopUp = transactions
        .filter((t) => t.type === "topup")
        .reduce((sum, t) => sum + (t.amount || 0), 0);

      return res.json({
        balance,
        currency: "EUR",
        projectCount,
        totalTopUp,
        transactions,
      });
    }

    res.json({
      balance,
      currency: "EUR",
      projectCount: 0,
      transactions: [],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
module.exports = router;
