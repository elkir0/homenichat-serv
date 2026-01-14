const express = require('express');
const router = express.Router();
const tokenMonitor = require('../services/TokenMonitor');
const { verifyToken, isAdmin } = require('../middleware/auth');
const logger = require('winston');

/**
 * GET /api/token/status
 * Obtenir le statut du token Meta
 */
router.get('/status', verifyToken, isAdmin, async (req, res) => {
  try {
    const status = await tokenMonitor.getStatus();
    res.json(status);
  } catch (error) {
    logger.error('Error getting token status:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération du statut' });
  }
});

/**
 * POST /api/token/check
 * Forcer une vérification du token
 */
router.post('/check', verifyToken, isAdmin, async (req, res) => {
  try {
    await tokenMonitor.checkTokenStatus();
    const status = await tokenMonitor.getStatus();
    res.json({
      message: 'Vérification effectuée',
      status
    });
  } catch (error) {
    logger.error('Error checking token:', error);
    res.status(500).json({ error: 'Erreur lors de la vérification' });
  }
});

/**
 * POST /api/token/exchange
 * Échanger le token actuel contre un token longue durée
 */
router.post('/exchange', verifyToken, isAdmin, async (req, res) => {
  try {
    const result = await tokenMonitor.exchangeForLongLivedToken();
    if (result.success) {
      res.json({
        message: 'Token échangé avec succès',
        expiresIn: result.expiresIn
      });
    } else {
      res.status(400).json({
        error: result.error || 'Échec de l\'échange du token'
      });
    }
  } catch (error) {
    logger.error('Error exchanging token:', error);
    res.status(500).json({ error: 'Erreur lors de l\'échange du token' });
  }
});

module.exports = router;