const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const db = require('../services/DatabaseService');
const { generateToken, verifyToken, isAdmin } = require('../middleware/auth');

const router = express.Router();

// Route de connexion
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username et password requis' });
    }

    // Chercher l'utilisateur
    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Vérifier le mot de passe
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Identifiants invalides' });
    }

    // Générer le token
    const token = generateToken(user);

    // Sauvegarder la session
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30); // 30 jours
    db.createSession(user.id, token, expiresAt);

    // Mettre à jour la dernière connexion
    db.updateLastLogin(user.id);

    // Retourner le token et les infos utilisateur
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role
      }
    });
  } catch (error) {
    console.error('Erreur login:', error);
    console.error('Stack trace:', error.stack);
    res.status(500).json({ error: 'Une erreur est survenue' });
  }
});

// Route pour vérifier le token
router.get('/verify', verifyToken, (req, res) => {
  res.json({
    valid: true,
    user: req.user
  });
});

// Route pour se déconnecter (révoquer le token)
router.post('/logout', verifyToken, async (req, res) => {
  try {
    // Supprimer la session de la base
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(' ')[1];

    if (token) {
      db.deleteSession(token);
    }

    res.json({ message: 'Déconnexion réussie' });
  } catch (error) {
    console.error('Erreur logout:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Routes admin pour gérer les utilisateurs
// Obtenir tous les utilisateurs
router.get('/users', verifyToken, isAdmin, async (req, res) => {
  try {
    const users = db.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('Erreur get users:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Créer un utilisateur
router.post('/users', verifyToken, isAdmin, [
  body('username').notEmpty().isLength({ min: 3 }).withMessage('Nom d\'utilisateur invalide'),
  body('password').isLength({ min: 6 }).withMessage('Mot de passe trop court'),
  body('role').isIn(['user', 'admin']).withMessage('Rôle invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { username, password, role } = req.body;

    // Hasher le mot de passe
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Créer l'utilisateur
    const newUser = db.createUser(username, hashedPassword, role);
    res.status(201).json(newUser);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      res.status(400).json({ error: 'Nom d\'utilisateur déjà pris' });
    } else {
      console.error('Erreur create user:', error);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  }
});

// Supprimer un utilisateur
router.delete('/users/:id', verifyToken, isAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Empêcher la suppression de son propre compte
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Impossible de supprimer votre propre compte' });
    }

    db.deleteUser(userId);
    res.json({ message: 'Utilisateur supprimé' });
  } catch (error) {
    console.error('Erreur delete user:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Changer le mot de passe (utilisateur courant - nécessite mot de passe actuel)
router.post('/change-password', verifyToken, [
  body('currentPassword').notEmpty().withMessage('Mot de passe actuel requis'),
  body('newPassword').isLength({ min: 6 }).withMessage('Nouveau mot de passe trop court')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { currentPassword, newPassword } = req.body;

    // Récupérer l'utilisateur avec le mot de passe
    const user = db.getUserByUsername(req.user.username);

    // Vérifier le mot de passe actuel
    const isValidPassword = await bcrypt.compare(currentPassword, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    }

    // Hasher le nouveau mot de passe
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Changer le mot de passe
    db.changePassword(req.user.id, hashedPassword);
    res.json({ message: 'Mot de passe changé avec succès' });
  } catch (error) {
    console.error('Erreur change password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Changer le mot de passe d'un utilisateur (sans besoin du mot de passe actuel)
router.put('/users/:id/password', verifyToken, isAdmin, [
  body('newPassword').isLength({ min: 6 }).withMessage('Mot de passe trop court (min 6 caractères)')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;

    // Vérifier que l'utilisateur existe
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Hasher le nouveau mot de passe
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);

    // Changer le mot de passe
    db.changePassword(userId, hashedPassword);
    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (error) {
    console.error('Erreur admin change password:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Modifier le rôle d'un utilisateur
router.put('/users/:id/role', verifyToken, isAdmin, [
  body('role').isIn(['user', 'admin']).withMessage('Rôle invalide')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const userId = parseInt(req.params.id);
    const { role } = req.body;

    // Empêcher de modifier son propre rôle
    if (userId === req.user.id) {
      return res.status(400).json({ error: 'Impossible de modifier votre propre rôle' });
    }

    // Vérifier que l'utilisateur existe
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    db.updateUserRole(userId, role);
    res.json({ message: 'Rôle modifié avec succès', role });
  } catch (error) {
    console.error('Erreur update role:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Obtenir la configuration VoIP d'un utilisateur (admin ou self)
router.get('/users/:id/voip', verifyToken, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);

    // Vérifier les permissions: admin ou l'utilisateur lui-même
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ error: 'Accès refusé' });
    }

    const config = db.getSetting(`user_${userId}_voip`);
    res.json(config || {
      enabled: false,
      wssUrl: '',
      domain: '',
      extension: '',
      password: '',
      displayName: ''
    });
  } catch (error) {
    console.error('Erreur get user voip:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// User: Configurer son propre VoIP (self-service)
router.put('/me/voip', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { enabled, wssUrl, domain, extension, password, displayName } = req.body;

    // Get global config for defaults
    const globalConfig = {
      server: process.env.VOIP_WSS_URL || '',
      domain: process.env.VOIP_DOMAIN || '',
    };

    // Save user VoIP config
    const voipConfig = {
      enabled: enabled !== false, // Default to true
      wssUrl: wssUrl || globalConfig.server,
      domain: domain || globalConfig.domain,
      extension: extension || '',
      password: password || '',
      displayName: displayName || req.user.username || '',
      updatedAt: Date.now()
    };

    db.setSetting(`user_${userId}_voip`, voipConfig);

    console.log(`[Auth] User ${userId} updated their VoIP config: ext ${extension}`);

    res.json({
      success: true,
      message: 'Configuration VoIP sauvegardée',
      config: {
        ...voipConfig,
        password: voipConfig.password ? '[SET]' : '' // Don't return actual password
      }
    });
  } catch (error) {
    console.error('Erreur set user voip:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// User: Get my VoIP config
router.get('/me/voip', verifyToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const config = db.getSetting(`user_${userId}_voip`);

    // Get global config for reference
    const globalConfig = {
      server: process.env.VOIP_WSS_URL || '',
      domain: process.env.VOIP_DOMAIN || '',
      defaultExtension: process.env.VOIP_EXTENSION || '',
    };

    res.json({
      success: true,
      config: config ? {
        ...config,
        password: config.password ? '[SET]' : '' // Don't return actual password
      } : null,
      globalConfig,
      hasConfig: !!(config && config.extension)
    });
  } catch (error) {
    console.error('Erreur get user voip:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Admin: Configurer VoIP d'un utilisateur
router.put('/users/:id/voip', verifyToken, isAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id);
    const { enabled, wssUrl, domain, extension, password, displayName } = req.body;

    // Vérifier que l'utilisateur existe
    const user = db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: 'Utilisateur non trouvé' });
    }

    // Sauvegarder la config VoIP complète
    const voipConfig = {
      enabled: !!enabled,
      wssUrl: wssUrl || '',
      domain: domain || '',
      extension: extension || '',
      password: password || '',
      displayName: displayName || ''
    };

    db.setSetting(`user_${userId}_voip`, voipConfig);
    res.json({ message: 'Configuration VoIP sauvegardée', config: voipConfig });
  } catch (error) {
    console.error('Erreur set user voip:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

module.exports = router;