const express = require('express');
const router = express.Router();
const providerManager = require('../services/ProviderManager');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const logger = require('winston');

// Toutes les routes nécessitent une authentification (sauf status pour debug)
// Toutes les routes nécessitent une authentification (sauf status pour debug)
router.use(verifyToken);

/**
 * GET /api/providers/status
 * Obtient le statut de tous les providers
 */
router.get('/status', async (req, res) => {
  try {
    const providers = providerManager.getAvailableProviders();
    const healthStatus = await providerManager.getHealthStatus();

    const activeProviders = Array.from(providerManager.activeProviders);
    res.json({
      success: true,
      activeProvider: activeProviders[0] || 'none', // Premier provider actif
      activeProviders: activeProviders, // Tous les providers actifs
      providers: providers,
      health: healthStatus
    });
  } catch (error) {
    logger.error('Error getting provider status:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/providers/config
 * Obtient la configuration actuelle (admin seulement)
 */
router.get('/config', requireAdmin, async (req, res) => {
  try {
    // Ne pas exposer les clés sensibles
    const config = JSON.parse(JSON.stringify(providerManager.config));

    // Masquer les informations sensibles
    if (config.providers.evolution) {
      config.providers.evolution.apiKey = config.providers.evolution.apiKey ? '***' : '';
    }
    if (config.providers.meta) {
      config.providers.meta.accessToken = config.providers.meta.accessToken ? '***' : '';
      config.providers.meta.appSecret = config.providers.meta.appSecret ? '***' : '';
    }
    if (config.providers['sms-bridge']) {
      config.providers['sms-bridge'].apiToken = config.providers['sms-bridge'].apiToken ? '***' : '';
    }

    res.json({
      success: true,
      config: config
    });
  } catch (error) {
    logger.error('Error getting provider config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * PUT /api/providers/config/:provider
 * Met à jour la configuration d'un provider (admin seulement)
 */
router.put('/config/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    const newConfig = req.body;

    // Validation basique
    if (!['evolution', 'meta', 'sms-bridge'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid provider name'
      });
    }

    // Ne pas écraser les clés sensibles si elles sont masquées
    const currentConfig = providerManager.config.providers[provider];
    if (provider === 'evolution' && newConfig.apiKey === '***') {
      newConfig.apiKey = currentConfig.apiKey;
    }
    if (provider === 'meta') {
      if (newConfig.accessToken === '***') {
        newConfig.accessToken = currentConfig.accessToken;
      }
      if (newConfig.appSecret === '***') {
        newConfig.appSecret = currentConfig.appSecret;
      }
    }
    if (provider === 'sms-bridge' && newConfig.apiToken === '***') {
      newConfig.apiToken = currentConfig.apiToken;
    }

    await providerManager.updateProviderConfig(provider, newConfig);

    res.json({
      success: true,
      message: 'Configuration updated successfully'
    });
  } catch (error) {
    logger.error('Error updating provider config:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});



/**
 * POST /api/providers/switch
 * Change le provider actif (admin seulement)
 */
router.post('/switch', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.body;

    if (!provider) {
      return res.status(400).json({
        success: false,
        error: 'Provider name is required'
      });
    }

    await providerManager.setActiveProvider(provider);

    res.json({
      success: true,
      message: `Switched to ${provider} provider`,
      activeProvider: provider
    });
  } catch (error) {
    logger.error('Error switching provider:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/test/:provider
 * Teste la connexion d'un provider (admin seulement)
 */
router.post('/test/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;

    const result = await providerManager.testProviderConnection(provider);

    res.json({
      success: result.success,
      message: result.message,
      provider: provider
    });
  } catch (error) {
    logger.error('Error testing provider:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * GET /api/providers/qr/:provider
 * Obtient le QR code pour la connexion (Baileys)
 */
router.get('/qr/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const providerInstance = providerManager.providers.get(provider);

    if (!providerInstance) {
      return res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
    }

    if (provider === 'baileys') {
      const connectionState = await providerInstance.getConnectionState();

      if (connectionState.qrCode) {
        res.json({
          success: true,
          qrCode: connectionState.qrCode,
          state: connectionState.state
        });
      } else if (connectionState.isConnected) {
        res.json({
          success: true,
          message: 'Already connected',
          state: 'connected'
        });
      } else {
        res.json({
          success: false,
          message: 'QR Code not available yet. Please wait...',
          state: connectionState.state
        });
      }
    } else {
      res.status(400).json({
        success: false,
        error: 'QR Code only available for Baileys provider'
      });
    }
  } catch (error) {
    logger.error('Error getting QR code:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/connect/:provider
 * Initie la connexion pour un provider
 */
router.post('/connect/:provider', async (req, res) => {
  try {
    const { provider } = req.params;
    const providerInstance = providerManager.providers.get(provider);

    if (!providerInstance) {
      // Charger le provider s'il n'est pas encore chargé
      await providerManager.loadSingleProvider(provider);
      const newInstance = providerManager.providers.get(provider);

      if (!newInstance) {
        return res.status(404).json({
          success: false,
          error: 'Provider not found or not enabled'
        });
      }

      await newInstance.initialize();
    } else {
      // Si le provider existe déjà, on vérifie s'il a besoin d'être relancé
      const state = await providerInstance.getConnectionState();
      if (state.state !== 'connected' && state.state !== 'connecting' && state.state !== 'qr') {
        logger.info(`Force re-initializing provider ${provider}...`);
        await providerInstance.initialize();
      }
    }

    const connectionState = await providerInstance.getConnectionState();

    res.json({
      success: true,
      state: connectionState.state,
      needsQR: connectionState.needsQR
    });
  } catch (error) {
    logger.error('Error connecting provider:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/disconnect/:provider
 * Déconnecte un provider
 */
router.post('/disconnect/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    const providerInstance = providerManager.providers.get(provider);

    if (!providerInstance) {
      return res.status(404).json({
        success: false,
        error: 'Provider not found'
      });
    }

    await providerInstance.logout();

    res.json({
      success: true,
      message: `Provider ${provider} disconnected`
    });
  } catch (error) {
    logger.error('Error disconnecting provider:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/reset/:provider
 * Réinitialisation d'urgence de la session (nucléaire)
 */
router.post('/reset/:provider', verifyToken, async (req, res) => {
  try {
    const { provider } = req.params;
    const providerInstance = providerManager.providers.get(provider);

    if (!providerInstance) {
      return res.status(404).json({ success: false, error: 'Provider not found' });
    }

    // Si c'est Baileys, on efface le dossier de session
    if (provider === 'baileys') {
      const fs = require('fs/promises');
      const path = require('path');
      const authPath = path.resolve(__dirname, '../../data/baileys_auth');

      logger.warn(`🔥 EMERGENCY RESET: Deleting Baileys session at ${authPath}`);

      try {
        if (providerInstance.sock) {
          providerInstance.sock.end(undefined);
        }
      } catch (e) {
        logger.warn('Socket close failed during reset (expected):', e.message);
      }

      try {
        await fs.rm(authPath, { recursive: true, force: true });
      } catch (e) {
        logger.error('Failed to delete session folder:', e);
      }

      // On force le redémarrage du processus pour être sûr que tout la mémoire est nettoyée
      setTimeout(() => {
        process.exit(1);
      }, 500);

      res.json({ success: true, message: 'Session deleted. Server restarting...' });
    } else {
      res.status(400).json({ success: false, error: 'Reset only supported for Baileys' });
    }

  } catch (error) {
    logger.error('Error resetting provider:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/providers/webhook/:provider
 * Configure le webhook pour un provider (admin seulement)
 */
router.post('/webhook/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;
    const { url, options } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        error: 'Webhook URL is required'
      });
    }

    const providerInstance = providerManager.providers.get(provider);
    if (!providerInstance) {
      return res.status(404).json({
        success: false,
        error: `Provider '${provider}' not found`
      });
    }

    const result = await providerInstance.setupWebhook(url, options);

    res.json({
      success: result.success,
      message: `Webhook configured for ${provider}`,
      url: url
    });
  } catch (error) {
    logger.error('Error configuring webhook:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/activate/:provider
 * Active un provider spécifique pour multi-sessions
 */
router.post('/activate/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;

    await providerManager.activateProvider(provider);

    res.json({
      success: true,
      message: `Provider '${provider}' activated`,
      provider: provider
    });
  } catch (error) {
    logger.error(`Error activating provider ${req.params.provider}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * POST /api/providers/deactivate/:provider
 * Désactive un provider spécifique
 */
router.post('/deactivate/:provider', requireAdmin, async (req, res) => {
  try {
    const { provider } = req.params;

    await providerManager.deactivateProvider(provider);

    res.json({
      success: true,
      message: `Provider '${provider}' deactivated`,
      provider: provider
    });
  } catch (error) {
    logger.error(`Error deactivating provider ${req.params.provider}:`, error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;