const Project = require("../models/project");
const { appendWalletLedger } = require("../utils/walletLedger");
const Proposal = require("../models/proposal");
const User = require("../models/User");
const Notification = require("../models/notification");

// --- 1. CRÉER UN PROJET (C'est ici que l'erreur se produisait) ---
exports.createProject = async (req, res) => {
  try {
    const { title, description, budget, clientEmail } = req.body;

    // Log pour débogage (à voir dans ton terminal VS Code)
    console.log("------------------------------------");
    console.log("📥 Requête reçue pour :", clientEmail);

    // 1. Chercher l'utilisateur par l'email envoyé par Flutter
    const user = await User.findOne({ email: clientEmail });

    if (!user) {
      console.log("❌ Utilisateur non trouvé en base.");
      return res.status(404).json({ message: "Utilisateur non trouvé" });
    }

    // 2. Créer le projet avec l'ID de l'utilisateur trouvé
    const newProject = new Project({
      title: title,
      description: description,
      budget: Number(budget),
      owner: user._id // <--- Attribution de l'ID à 'owner'
    });

    // 3. Sauvegarder dans MongoDB
    await newProject.save();
    console.log("✅ Projet créé avec succès !");
    console.log("------------------------------------");

    res.status(201).json(newProject);
  } catch (error) {
    console.log("🔥 Erreur lors de la création :", error.message);
    res.status(500).json({ message: "Erreur serveur", error: error.message });
  }
};
exports.getAllProjects = async (req, res) => {
  try {
    // On récupère TOUS les projets et on remplit les infos du client (owner)
    const projects = await Project.find().populate("owner", "name email");
    console.log(`🔍 ${projects.length} projets envoyés au freelancer`);
    res.json(projects);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// --- 2. RÉCUPÉRER TOUS LES PROJETS (Admin ou Freelancer) ---
exports.getProjects = async (req, res) => {
  try {
    const projects = await Project.find()
      .populate("owner", "name avatar email")
      .sort({ createdAt: -1 });

    let enriched = projects.map((p) => p.toObject());

    if (req.user) {
      const ids = enriched.map((p) => p._id);
      const mine = await Proposal.find({
        freelancer: req.user._id,
        project: { $in: ids },
      })
        .select("project status")
        .lean();

      const statusByProject = {};
      for (const row of mine) {
        statusByProject[row.project.toString()] = row.status;
      }

      enriched = enriched.map((p) => ({
        ...p,
        userProposalStatus: statusByProject[p._id.toString()] || "none",
      }));
    } else {
      enriched = enriched.map((p) => ({
        ...p,
        userProposalStatus: "none",
      }));
    }

    res.status(200).json(enriched);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// --- 3. RÉCUPÉRER TOUS LES PROJETS (Dashboard Admin spécifique) ---
exports.getAllProjectsAdmin = async (req, res) => {
  try {
    const projects = await Project.find()
      .populate('owner', 'name avatar')
      .sort({ createdAt: -1 });
    
    res.status(200).json(projects);
  } catch (err) {
    res.status(500).json({ message: "Erreur récupération admin", error: err.message });
  }
};

// --- 4. MODIFIER UN PROJET ---
exports.updateProject = async (req, res) => {
  try {
    const { id } = req.params;
    const project = await Project.findByIdAndUpdate(id, req.body, { new: true });

    if (!project) return res.status(404).json({ message: "Projet non trouvé" });

    res.status(200).json({ message: "Projet modifié avec succès", project });
  } catch (error) {
    res.status(500).json({ message: "Erreur modification", error });
  }
};

// --- 5. SUPPRIMER UN PROJET (client : seulement tant qu’aucun freelancer accepté / pas d’escrow) ---
exports.deleteProject = async (req, res) => {
  try {
    const { id } = req.params;
    const project = await Project.findById(id);

    if (!project) return res.status(404).json({ message: "Projet non trouvé" });

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    const hasAcceptedFreelancer = !!project.acceptedFreelancer;
    const fundsInEscrow = project.paymentStatus === "escrow_locked";

    if (hasAcceptedFreelancer || fundsInEscrow) {
      return res.status(403).json({
        code: "CANCEL_VIA_ADMIN",
        message:
          "Impossible de supprimer : une offre a été acceptée et les fonds sont en escrow. Demandez l’annulation à l’administration.",
      });
    }

    const canRefundWallet =
      project.fundedFromWallet &&
      project.status === "open" &&
      project.paymentStatus === "not_locked";

    if (canRefundWallet) {
      await User.findByIdAndUpdate(project.owner, {
        $inc: { walletBalance: project.budget },
      });
      await appendWalletLedger(project.owner, {
        type: "refund",
        amount: project.budget || 0,
        label: `Remboursement — ${project.title || "Mission"}`,
        refId: `refund:project:${project._id}`,
      });
    }

    await Proposal.deleteMany({ project: project._id });
    await Project.findByIdAndDelete(id);

    res.status(200).json({ message: "Projet supprimé avec succès" });
  } catch (error) {
    res.status(500).json({ message: "Erreur suppression", error });
  }
};

// --- 5b. Métadonnées participant & livrable admin ---
exports.getProjectParticipantMeta = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .select(
        "title status paymentStatus escrowStatus acceptedFreelancer owner adminWorkSubmission cancellationRequested"
      )
      .lean();

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    const uid = req.user._id.toString();
    const ownerId = project.owner?.toString?.() ?? String(project.owner);
    const freelancerId =
      project.acceptedFreelancer?.toString?.() ?? String(project.acceptedFreelancer ?? '');

    if (uid !== ownerId && uid !== freelancerId) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    res.json(project);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** Client : missions dont le livrable a été validé par le client (en attente admin ou déjà libéré). */
exports.getClientConfirmedDeliveries = async (req, res) => {
  try {
    if (req.user.role !== "client") {
      return res.status(403).json({ message: "Réservé aux clients" });
    }

    const projects = await Project.find({
      owner: req.user._id,
      "adminWorkSubmission.status": { $in: ["client_approved", "approved"] },
    })
      .populate("acceptedFreelancer", "name email avatar")
      .select(
        "title description budget status paymentStatus escrowStatus adminWorkSubmission acceptedFreelancer createdAt updatedAt escrowAmount"
      )
      .sort({ updatedAt: -1 })
      .lean();

    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/**
 * Freelancer : envoie fichiers / lien / message au **client** pour validation, puis l’admin libère l’escrow.
 */
exports.submitWorkForAdminReview = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    const uid = req.user._id.toString();
    if (
      !project.acceptedFreelancer ||
      project.acceptedFreelancer.toString() !== uid
    ) {
      return res.status(403).json({ message: "Réservé au freelancer assigné" });
    }

    if (project.paymentStatus !== "escrow_locked") {
      return res.status(400).json({
        message: "Aucun paiement en escrow — envoi impossible",
      });
    }

    if (project.cancellationRequested) {
      return res.status(400).json({
        message: "Annulation en cours — envoi suspendu",
      });
    }

    const sub = project.adminWorkSubmission;
    const st = sub?.status;
    if (
      st === "pending_client" ||
      st === "pending_review"
    ) {
      return res.status(400).json({
        message:
          "Un livrable est déjà en attente de validation par le client",
      });
    }
    if (st === "client_approved" || st === "approved") {
      return res.status(400).json({
        message:
          "Le client a déjà validé ce livrable — la libération des fonds est du ressort de l’administration",
      });
    }

    const demoLink =
      typeof req.body?.demoLink === "string" ? req.body.demoLink.trim() : "";
    const message =
      typeof req.body?.message === "string" ? req.body.message.trim() : "";

    const files = (req.files || []).map((f) => ({
      filename: f.filename,                    // Cloudinary public_id
      url: f.path,                             // Cloudinary HTTPS URL
      originalName: f.originalname || "",
      mimeType: f.mimetype || "",
      size: Number(f.size) || 0,
    }));

    if (!files.length && !demoLink && !message) {
      return res.status(400).json({
        message:
          "Ajoutez au moins un fichier, un lien ou un message pour le client",
      });
    }

    project.adminWorkSubmission = {
      status: "pending_client",
      message: message.slice(0, 4000),
      demoLink: demoLink.slice(0, 2000),
      files,
      submittedAt: new Date(),
      reviewedAt: null,
      reviewNote: "",
    };

    if (project.status === "in_progress" || project.status === "open") {
      project.status = "delivered";
    }

    await project.save();
await Notification.create({
  userId: project.owner,
  title: "Livrable reçu 📦",
  message: `Le freelancer a envoyé le travail pour « ${project.title} ». Ouvrez le suivi de mission pour valider.`,
});
    const io = req.app.get("socketio");
    if (io && project.owner) {
      io.to(project.owner.toString()).emit("notification", {
        title: "Livrable reçu 📦",
        message: `Le freelancer a envoyé le travail pour « ${project.title} ». Ouvrez le suivi de mission pour valider.`,
        projectId: project._id,
      });
    }

    res.json({
      message:
        "Livrable envoyé au client. Vous serez notifié après sa validation, puis l’administration libérera le paiement.",
      project,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** Client : valide le livrable freelancer — ensuite seul l’admin peut libérer l’escrow. */
exports.approveClientWorkSubmission = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    if (project.paymentStatus !== "escrow_locked") {
      return res.status(400).json({
        message: "Aucun paiement en escrow pour cette mission",
      });
    }

    const st = project.adminWorkSubmission?.status;
    if (st !== "pending_client" && st !== "pending_review") {
      return res.status(400).json({
        message: "Aucun livrable en attente de votre validation",
      });
    }

    project.adminWorkSubmission.status = "client_approved";
    project.adminWorkSubmission.reviewedAt = new Date();
    project.adminWorkSubmission.reviewNote = "";

    await project.save();

    const io = req.app.get("socketio");
    if (io && project.acceptedFreelancer) {
      io.to(project.acceptedFreelancer.toString()).emit("notification", {
        title: "Livrable accepté par le client ✓",
        message:
          "Le client a validé votre travail. L’administration va libérer le paiement sur votre wallet.",
        projectId: project._id,
      });
    }

    res.json({
      message:
        "Merci — la validation est enregistrée. L’administration peut maintenant libérer le paiement au freelancer.",
      project,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

/** Client : refuse le livrable ; le freelancer peut en envoyer un nouveau. */
exports.rejectClientWorkSubmission = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    if (project.paymentStatus !== "escrow_locked") {
      return res.status(400).json({
        message: "Aucun paiement en escrow pour cette mission",
      });
    }

    const st = project.adminWorkSubmission?.status;
    if (st !== "pending_client" && st !== "pending_review") {
      return res.status(400).json({
        message: "Aucun livrable en attente de votre validation",
      });
    }

    const note =
      typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 2000) : "";

    project.adminWorkSubmission.status = "client_rejected";
    project.adminWorkSubmission.reviewedAt = new Date();
    project.adminWorkSubmission.reviewNote = note;

    if (project.status === "delivered") {
      project.status = "in_progress";
    }

    await project.save();

    const io = req.app.get("socketio");
    if (io && project.acceptedFreelancer) {
      io.to(project.acceptedFreelancer.toString()).emit("notification", {
        title: "Livrable à corriger",
        message:
          note ||
          "Le client demande des corrections. Renvoyez un livrable depuis le chat mission.",
        projectId: project._id,
      });
    }

    res.json({
      message:
        "Votre retour a été envoyé au freelancer.",
      project,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.requestMissionCancellation = async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    if (project.owner.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Non autorisé" });
    }

    if (project.paymentStatus !== "escrow_locked") {
      return res.status(400).json({
        message:
          "Aucun paiement en escrow pour cette mission. Vous pouvez supprimer la mission si elle est encore ouverte sans freelancer accepté.",
      });
    }

    if (project.cancellationRequested) {
      return res.status(200).json({
        message: "Votre demande d’annulation a déjà été envoyée à l’administration.",
        alreadyRequested: true,
      });
    }

    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    project.cancellationRequested = true;
    project.cancellationReason = reason.slice(0, 2000);
    project.cancellationRequestedAt = new Date();
    project.cancellationReviewNote = "";
    await project.save();

    res.json({
      message:
        "Demande enregistrée. L’administration examinera votre demande et remboursera votre wallet si elle est acceptée.",
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// Dans ton controller Node.js (projectController.js)
const addProject = async (req, res) => {
    try {
        const { title, description, budget, clientEmail } = req.body;
        
        // DEBUG : Ajoute cette ligne pour voir ce que Node reçoit
        console.log("RECU DU FRONT:", req.body);

        const user = await User.findOne({ email: clientEmail });
        
        if (!user) {
            return res.status(404).json({ message: "Utilisateur non trouvé" });
        }

        const newProject = new Project({
            title,
            description,
            budget,
            owner: user._id // <--- Si user est null, ça plante ici !
        });

        await newProject.save();
        res.status(201).json(newProject);
    } catch (error) {
        console.error("ERREUR:", error.message);
        res.status(500).json({ message: "Erreur serveur", error: error.message });
    }
};
// --- 6. APPROUVER ET LIBÉRER LES FONDS (Action Client) ---
exports.approveAndReleaseFunds = async (req, res) => {
  try {
    const { id } = req.params;
    const project = await Project.findById(id);

    if (!project) return res.status(404).json({ message: "Projet non trouvé" });

    // Sécurité : Seul le propriétaire (owner) peut approuver
    // if (project.owner.toString() !== req.user._id.toString()) {
    //   return res.status(403).json({ message: "Non autorisé" });
    // }

    project.status = "completed";
    project.paymentStatus = "released";
    
    await project.save();

    console.log(`✅ Fonds libérés pour le projet : ${project.title}`);
    res.status(200).json({ message: "Paiement libéré au freelance avec succès !", project });
  } catch (error) {
    res.status(500).json({ message: "Erreur lors de la libération des fonds", error: error.message });
  }
};
// --- 7. ACTIONS ADMIN (Litige) ---
exports.adminReleaseOrRefund = async (req, res) => {
  try {
    const { id } = req.params;
    const { action } = req.body; // 'release' ou 'refund'

    const project = await Project.findById(id);
    if (!project) return res.status(404).json({ message: "Projet non trouvé" });

    if (action === "release") {
      project.status = "completed";
      project.paymentStatus = "released";
    } else if (action === "refund") {
      project.status = "cancelled";
      project.paymentStatus = "refunded";
    }

    await project.save();
    res.status(200).json({ message: `Action Admin : ${action} effectuée`, project });
  } catch (error) {
    res.status(500).json({ message: "Erreur Admin", error: error.message });
  }
};


exports.deliverProject = async (req, res) => {
  try {

    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    project.status = "delivered";

    project.delivery = {
      message: req.body.message,
      link: req.body.link,
      status: "delivered",
      deliveredAt: new Date()
    };

    await project.save();

    return res.json({ message: "Travail livré ✅", project });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
// Exemple d'une fonction dans ton controller
exports.updateProjectStatus = async (req, res) => {
    try {
        const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true });

        // ✅ C'est ICI qu'on récupère 'io' via 'req'
        const io = req.app.get("socketio");
        
        if (io) {
            io.to(project.owner.toString()).emit("notification", {
                title: "Statut mis à jour",
                message: `Le projet ${project.title} est passé en statut ${project.status}`
            });
        }

        res.status(200).json(project);
    } catch (error) {
        res.status(500).json({ message: error.message });
    }
};
exports.getStats = async (req, res) => {
  try {

    const users = await User.find().select("name email role");
    const projects = await Project.find();

    return res.json({
      users, // 🔥 LIST FULL USERS
      projects: {
        open: projects.filter(p => p.status === "open").length,
        inProgress: projects.filter(p => p.status === "in_progress").length,
        completed: projects.filter(p => p.status === "completed").length
      }
    });

  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
exports.refuseDelivery = async (req, res) => {
  try {
    const { reason } = req.body;

    const project = await Project.findById(req.params.id);

    if (!project) {
      return res.status(404).json({ message: "Projet non trouvé" });
    }

    if (project.status !== "delivered") {
      return res.status(400).json({
        message: "Le projet n'est pas encore livré"
      });
    }

    // ✅ FIX CLEAN STRUCTURE
    project.delivery = {
      ...project.delivery,
      status: "refused",
      refusedReason: reason,
      refusedAt: new Date()
    };

    // 🔁 يرجّع الخدمة للفريلانسر
    project.status = "in_progress";

    await project.save();

    return res.status(200).json({
      message: "Livraison refusée",
      project
    });

  } catch (err) {
    return res.status(500).json({
      message: err.message
    });
  }
};
