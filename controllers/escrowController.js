const Project = require("../models/project");
const User = require("../models/User");
const Notification = require("../models/notification");

exports.getEscrowProjects = async (req, res) => {
  try {
    const projects = await Project.find({
      paymentStatus: "escrow_locked"
    })
    .populate("owner", "name email")
    .populate("acceptedFreelancer", "name email");
    return res.json(projects);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.releaseFunds = async (req, res) => {
  try {
    const { projectId } = req.body;
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: "Projet introuvable" });
    project.paymentStatus = "released";
    project.escrowStatus = "released";
    project.status = "completed";
    await project.save();
    await Notification.create({
      userId: project.acceptedFreelancer,
      title: "Paiement reçu 💸",
      message: `L'administration a libéré le paiement pour « ${project.title} ». Vérifiez votre wallet.`,
    });
    await Notification.create({
      userId: project.owner,
      title: "Mission terminée ✅",
      message: `Le paiement a été envoyé au freelancer pour « ${project.title} ».`,
    });
    return res.json({ message: "Funds released" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};

exports.refundClient = async (req, res) => {
  try {
    const { projectId } = req.body;
    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ message: "Projet introuvable" });
    project.paymentStatus = "refunded";
    project.escrowStatus = "refunded";
    project.status = "cancelled";
    await project.save();
    await Notification.create({
      userId: project.owner,
      title: "Remboursement effectué 💰",
      message: `Votre paiement pour « ${project.title} » a été remboursé sur votre wallet.`,
    });
    return res.json({ message: "Client refunded" });
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
};
