/**
 * Routes pour la configuration VoIP
 *
 * GET /api/config/voip - Récupère la configuration WebRTC/SIP (per-user si configuré)
 */
const express = require('express');
const router = express.Router();
const db = require('../services/DatabaseService');
const { verifyToken } = require('../middleware/auth');

// Configuration globale VoIP (serveur commun)
const getGlobalConfig = () => ({
  server: process.env.VOIP_WSS_URL || '',
  domain: process.env.VOIP_DOMAIN || '',
  extension: process.env.VOIP_EXTENSION || '',
  password: process.env.VOIP_PASSWORD || '',
  displayName: process.env.VOIP_DISPLAY_NAME || 'Homenichat WebRTC',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
});

/**
 * GET /api/config/voip
 * Retourne la configuration pour se connecter au PBX FreePBX via WebRTC
 * Si l'utilisateur est connecté et a une config VoIP personnalisée, utilise ses paramètres
 * Sinon, utilise la config globale
 */
router.get('/voip', verifyToken, (req, res) => {
  const globalConfig = getGlobalConfig();

  // Chercher config VoIP spécifique à l'utilisateur
  if (req.user && req.user.id) {
    const userVoip = db.getSetting(`user_${req.user.id}_voip`);

    if (userVoip && userVoip.enabled && userVoip.extension) {
      // Utiliser la config user complète
      return res.json({
        server: userVoip.wssUrl || globalConfig.server,
        domain: userVoip.domain || globalConfig.domain,
        extension: userVoip.extension,
        password: userVoip.password || '',
        displayName: userVoip.displayName || `${req.user.username} - L'ekip-Chat`,
        iceServers: globalConfig.iceServers,
        isUserConfig: true
      });
    }
  }

  // Fallback sur config globale
  res.json({
    ...globalConfig,
    isUserConfig: false
  });
});

/**
 * GET /api/config/voip/status
 * Vérifie si la configuration VoIP est disponible
 */
router.get('/voip/status', verifyToken, (req, res) => {
  const hasEnvConfig = !!(process.env.VOIP_WSS_URL || process.env.VOIP_EXTENSION);

  // Vérifier si l'utilisateur a une config personnalisée
  let hasUserConfig = false;
  if (req.user && req.user.id) {
    const userVoip = db.getSetting(`user_${req.user.id}_voip`);
    hasUserConfig = !!(userVoip && userVoip.enabled && userVoip.extension);
  }

  res.json({
    configured: true,
    hasEnvOverrides: hasEnvConfig,
    hasUserConfig,
    server: process.env.VOIP_WSS_URL ? 'custom' : 'default (FreePBX)'
  });
});

/**
 * GET /api/config/voip/global
 * Retourne la config globale (pour l'admin uniquement, pour afficher le serveur/domaine)
 */
router.get('/voip/global', verifyToken, (req, res) => {
  const globalConfig = getGlobalConfig();

  // Ne pas retourner le password global pour des raisons de sécurité
  res.json({
    server: globalConfig.server,
    domain: globalConfig.domain,
    defaultExtension: globalConfig.extension,
    displayName: globalConfig.displayName
  });
});

module.exports = router;
