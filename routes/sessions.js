const express = require('express');
const router = express.Router();
const { verifyToken, isAdmin } = require('../middleware/auth');
const sessionManager = require('../services/SessionManager');
const logger = require('../utils/logger');

// Obtenir toutes les sessions
router.get('/', verifyToken, async (req, res) => {
  try {
    const sessions = sessionManager.getAllSessions();
    const activeSessionId = sessionManager.activeSessionId;
    
    res.json({
      sessions,
      activeSessionId
    });
  } catch (error) {
    logger.error('Error getting sessions:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des sessions' });
  }
});

// Obtenir une session spécifique
router.get('/:sessionId', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }
    
    // Obtenir l'état de connexion
    const connectionState = await sessionManager.getSessionConnectionState(sessionId);
    
    res.json({
      id: sessionId,
      name: session.name,
      phoneNumber: session.phoneNumber,
      providerType: session.providerType,
      state: connectionState.state,
      enabled: session.enabled,
      isActive: sessionId === sessionManager.activeSessionId,
      createdAt: session.createdAt,
      lastActivity: session.lastActivity
    });
  } catch (error) {
    logger.error('Error getting session:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de la session' });
  }
});

// Créer une nouvelle session (admin uniquement)
router.post('/', verifyToken, isAdmin, async (req, res) => {
  try {
    const { name, providerType, phoneNumber, config } = req.body;
    
    if (!name || !providerType) {
      return res.status(400).json({ error: 'Nom et type de provider requis' });
    }
    
    // Générer un ID unique pour la session
    const sessionId = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    const session = await sessionManager.createSession(sessionId, {
      name,
      providerType,
      phoneNumber,
      config,
      enabled: true
    });
    
    res.status(201).json({
      id: sessionId,
      name: session.name,
      phoneNumber: session.phoneNumber,
      providerType: session.providerType,
      state: session.state,
      enabled: session.enabled
    });
  } catch (error) {
    logger.error('Error creating session:', error);
    res.status(500).json({ error: 'Erreur lors de la création de la session' });
  }
});

// Mettre à jour une session (admin uniquement)
router.put('/:sessionId', verifyToken, isAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const updates = req.body;
    
    const session = await sessionManager.updateSessionConfig(sessionId, updates);
    
    res.json({
      id: sessionId,
      name: session.name,
      phoneNumber: session.phoneNumber,
      providerType: session.providerType,
      state: session.state,
      enabled: session.enabled
    });
  } catch (error) {
    logger.error('Error updating session:', error);
    res.status(500).json({ error: 'Erreur lors de la mise à jour de la session' });
  }
});

// Supprimer une session (admin uniquement)
router.delete('/:sessionId', verifyToken, isAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    await sessionManager.deleteSession(sessionId);
    
    res.json({ message: 'Session supprimée avec succès' });
  } catch (error) {
    logger.error('Error deleting session:', error);
    res.status(500).json({ error: 'Erreur lors de la suppression de la session' });
  }
});

// Activer une session
router.post('/:sessionId/activate', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    await sessionManager.setActiveSession(sessionId);
    
    res.json({ message: 'Session activée avec succès' });
  } catch (error) {
    logger.error('Error activating session:', error);
    res.status(500).json({ error: 'Erreur lors de l\'activation de la session' });
  }
});

// Basculer l'état enabled/disabled d'une session
router.patch('/:sessionId/toggle', verifyToken, isAdmin, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { enabled } = req.body;
    
    await sessionManager.toggleSession(sessionId, enabled);
    
    res.json({ 
      message: enabled ? 'Session activée' : 'Session désactivée',
      enabled 
    });
  } catch (error) {
    logger.error('Error toggling session:', error);
    res.status(500).json({ error: 'Erreur lors du changement d\'état de la session' });
  }
});

// Obtenir l'état de connexion d'une session
router.get('/:sessionId/connection', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    
    const connectionState = await sessionManager.getSessionConnectionState(sessionId);
    
    res.json(connectionState);
  } catch (error) {
    logger.error('Error getting connection state:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération de l\'état de connexion' });
  }
});

// Obtenir le QR code pour Evolution API
router.get('/:sessionId/qr', verifyToken, async (req, res) => {
  try {
    const { sessionId } = req.params;
    const session = sessionManager.getSession(sessionId);
    
    if (!session) {
      return res.status(404).json({ error: 'Session non trouvée' });
    }
    
    if (session.providerType !== 'baileys') {
      return res.status(400).json({ error: 'QR code disponible uniquement pour Baileys' });
    }
    
    // Obtenir le QR code du provider
    const qrCode = await session.provider.getQRCode();
    
    res.json({ qrCode });
  } catch (error) {
    logger.error('Error getting QR code:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du QR code' });
  }
});

// Statistiques globales (admin uniquement)
router.get('/stats/global', verifyToken, isAdmin, async (req, res) => {
  try {
    const stats = sessionManager.getGlobalStats();
    
    res.json(stats);
  } catch (error) {
    logger.error('Error getting global stats:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
  }
});

module.exports = router;