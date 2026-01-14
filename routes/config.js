/**
 * Routes API pour la gestion de configuration YAML
 *
 * Endpoints:
 * GET  /api/config                    - Configuration complète
 * GET  /api/config/providers/:type    - Providers par catégorie
 * POST /api/config/providers/:type    - Ajouter un provider
 * PUT  /api/config/providers/:type/:id - Modifier un provider
 * DELETE /api/config/providers/:type/:id - Supprimer un provider
 * POST /api/config/reload             - Recharger la config
 */

const express = require('express');
const router = express.Router();
const { verifyToken, requireAdmin } = require('../middleware/auth');
const configService = require('../services/ConfigurationService');
const providerManager = require('../services/ProviderManager');
const logger = require('winston');

/**
 * GET /api/config
 * Retourne la configuration complète (sans secrets)
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const config = configService.getConfig();

    // Masquer les secrets dans la réponse
    const sanitized = sanitizeConfig(config);

    res.json({
      success: true,
      version: configService.getVersion(),
      instance: configService.getInstance(),
      config: sanitized
    });
  } catch (error) {
    logger.error('[Config API] Error getting config:', error);
    res.status(500).json({ error: 'Failed to get configuration' });
  }
});

/**
 * GET /api/config/providers/:type
 * Retourne les providers d'une catégorie (whatsapp, sms, voip)
 */
router.get('/providers/:type', verifyToken, async (req, res) => {
  try {
    const { type } = req.params;
    const validTypes = ['whatsapp', 'sms', 'voip'];

    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: `Invalid provider type. Valid types: ${validTypes.join(', ')}`
      });
    }

    const providers = configService.getProviders(type);
    const sanitized = providers.map(p => sanitizeProvider(p));

    // Ajouter le statut de chaque provider
    const withStatus = await Promise.all(sanitized.map(async (p) => {
      const status = await getProviderStatus(type, p.id);
      return { ...p, status };
    }));

    res.json({
      success: true,
      type,
      providers: withStatus
    });
  } catch (error) {
    logger.error('[Config API] Error getting providers:', error);
    res.status(500).json({ error: 'Failed to get providers' });
  }
});

/**
 * POST /api/config/providers/:type
 * Ajoute un nouveau provider
 */
router.post('/providers/:type', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type } = req.params;
    const providerData = req.body;

    // Validation basique
    if (!providerData.id || !providerData.type) {
      return res.status(400).json({
        error: 'Provider id and type are required'
      });
    }

    // Vérifier que l'ID est valide (alphanumérique + underscore)
    if (!/^[a-z0-9_]+$/.test(providerData.id)) {
      return res.status(400).json({
        error: 'Provider id must contain only lowercase letters, numbers and underscores'
      });
    }

    const newProvider = await configService.addProvider(type, {
      id: providerData.id,
      type: providerData.type,
      enabled: providerData.enabled || false,
      config: providerData.config || {}
    });

    logger.info(`[Config API] Provider added: ${type}/${providerData.id}`);

    res.json({
      success: true,
      message: 'Provider added successfully',
      provider: sanitizeProvider(newProvider)
    });
  } catch (error) {
    logger.error('[Config API] Error adding provider:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/config/providers/:type/:id
 * Modifie un provider existant
 */
router.put('/providers/:type/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;
    const updates = req.body;

    // Vérifier que le provider existe
    const existing = configService.getProvider(type, id);
    if (!existing) {
      return res.status(404).json({
        error: `Provider ${id} not found in ${type}`
      });
    }

    // Appliquer les mises à jour
    const updated = await configService.updateProvider(type, id, updates);

    // Si le provider était actif et a été désactivé, le désactiver dans le manager
    if (existing.enabled && updates.enabled === false) {
      try {
        await providerManager.deactivateProvider(id);
      } catch (e) {
        logger.warn(`[Config API] Could not deactivate provider ${id}:`, e.message);
      }
    }

    // Si le provider a été activé, tenter de l'activer
    if (!existing.enabled && updates.enabled === true) {
      try {
        await providerManager.activateProvider(id);
      } catch (e) {
        logger.warn(`[Config API] Could not activate provider ${id}:`, e.message);
      }
    }

    logger.info(`[Config API] Provider updated: ${type}/${id}`);

    res.json({
      success: true,
      message: 'Provider updated successfully',
      provider: sanitizeProvider(updated)
    });
  } catch (error) {
    logger.error('[Config API] Error updating provider:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/config/providers/:type/:id
 * Supprime un provider
 */
router.delete('/providers/:type/:id', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;

    // Vérifier que le provider existe
    const existing = configService.getProvider(type, id);
    if (!existing) {
      return res.status(404).json({
        error: `Provider ${id} not found in ${type}`
      });
    }

    // Si le provider est actif, le désactiver d'abord
    if (existing.enabled) {
      try {
        await providerManager.deactivateProvider(id);
      } catch (e) {
        logger.warn(`[Config API] Could not deactivate provider ${id}:`, e.message);
      }
    }

    // Supprimer de la configuration
    await configService.removeProvider(type, id);

    logger.info(`[Config API] Provider deleted: ${type}/${id}`);

    res.json({
      success: true,
      message: 'Provider deleted successfully'
    });
  } catch (error) {
    logger.error('[Config API] Error deleting provider:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PATCH /api/config/providers/:type/:id/toggle
 * Active/désactive rapidement un provider
 */
router.patch('/providers/:type/:id/toggle', verifyToken, requireAdmin, async (req, res) => {
  try {
    const { type, id } = req.params;

    const existing = configService.getProvider(type, id);
    if (!existing) {
      return res.status(404).json({
        error: `Provider ${id} not found in ${type}`
      });
    }

    const newEnabled = !existing.enabled;
    await configService.setProviderEnabled(type, id, newEnabled);

    // Activer/désactiver dans le manager
    if (newEnabled) {
      try {
        await providerManager.activateProvider(id);
      } catch (e) {
        logger.warn(`[Config API] Could not activate provider ${id}:`, e.message);
      }
    } else {
      try {
        await providerManager.deactivateProvider(id);
      } catch (e) {
        logger.warn(`[Config API] Could not deactivate provider ${id}:`, e.message);
      }
    }

    res.json({
      success: true,
      enabled: newEnabled,
      message: `Provider ${id} ${newEnabled ? 'enabled' : 'disabled'}`
    });
  } catch (error) {
    logger.error('[Config API] Error toggling provider:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/config/reload
 * Force le rechargement de la configuration
 */
router.post('/reload', verifyToken, requireAdmin, async (req, res) => {
  try {
    await configService.load();
    logger.info('[Config API] Configuration reloaded');

    res.json({
      success: true,
      message: 'Configuration reloaded'
    });
  } catch (error) {
    logger.error('[Config API] Error reloading config:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/config/provider-types
 * Retourne les types de providers disponibles par catégorie
 */
router.get('/provider-types', verifyToken, (req, res) => {
  res.json({
    success: true,
    types: {
      whatsapp: [
        { type: 'baileys', name: 'WhatsApp QR (Baileys)', description: 'Connexion via QR Code, gratuit, self-hosted' },
        { type: 'meta_cloud', name: 'WhatsApp Business API', description: 'API officielle Meta, payant, nécessite vérification' }
      ],
      sms: [
        { type: 'sms_bridge', name: 'SMS Bridge (Interne)', description: 'Pont SMS vers SIP trunk local' },
        { type: 'ovh', name: 'OVH SMS', description: 'Service SMS OVH France' },
        { type: 'twilio', name: 'Twilio', description: 'Plateforme SMS internationale' },
        { type: 'plivo', name: 'Plivo', description: 'Alternative à Twilio' },
        { type: 'messagebird', name: 'MessageBird', description: 'Service SMS européen' },
        { type: 'vonage', name: 'Vonage (Nexmo)', description: 'Service SMS global' },
        { type: 'smpp', name: 'SMPP Gateway', description: 'Connexion directe opérateur' },
        { type: 'gammu', name: 'Gammu (Modem USB)', description: 'Modem GSM local' }
      ],
      voip: [
        { type: 'freepbx', name: 'FreePBX/Asterisk', description: 'PBX open-source avec AMI' },
        { type: 'generic_sip', name: 'SIP Générique', description: 'Serveur SIP standard' },
        { type: 'ovh_trunk', name: 'OVH Trunk SIP', description: 'Trunk SIP OVH France' },
        { type: 'twilio_voice', name: 'Twilio Voice', description: 'VoIP Twilio' },
        { type: 'telnyx', name: 'Telnyx', description: 'Service VoIP flexible' }
      ]
    }
  });
});

/**
 * GET /api/config/compliance
 * Retourne les règles de compliance configurées
 */
router.get('/compliance', verifyToken, (req, res) => {
  try {
    const config = configService.getConfig();
    res.json({
      success: true,
      compliance: config.compliance || {}
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== Helpers ====================

/**
 * Masque les secrets dans la configuration
 */
function sanitizeConfig(config) {
  if (!config) return config;

  const sanitized = JSON.parse(JSON.stringify(config));

  // Parcourir tous les providers et masquer les secrets
  for (const type of ['whatsapp', 'sms', 'voip']) {
    if (sanitized.providers?.[type]) {
      sanitized.providers[type] = sanitized.providers[type].map(p => sanitizeProvider(p));
    }
  }

  return sanitized;
}

/**
 * Masque les secrets d'un provider
 */
function sanitizeProvider(provider) {
  if (!provider?.config) return provider;

  const sanitized = JSON.parse(JSON.stringify(provider));
  const secretFields = [
    'password', 'secret', 'token', 'api_key', 'auth_token',
    'access_token', 'app_secret', 'consumer_key', 'ami_secret',
    'sip_password'
  ];

  for (const field of secretFields) {
    if (sanitized.config[field]) {
      sanitized.config[field] = '••••••••';
    }
  }

  return sanitized;
}

/**
 * Récupère le statut d'un provider
 */
async function getProviderStatus(type, id) {
  try {
    // Pour l'instant, retourner un statut basique
    // Plus tard, intégrer avec le providerManager
    const provider = configService.getProvider(type, id);
    return {
      configured: !!provider,
      enabled: provider?.enabled || false,
      connected: false // TODO: intégrer avec le vrai statut
    };
  } catch (e) {
    return { configured: false, enabled: false, connected: false };
  }
}

module.exports = router;
