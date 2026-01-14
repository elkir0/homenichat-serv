const express = require('express');
const router = express.Router();
const providerManager = require('../services/ProviderManager');
const { verifyToken } = require('../middleware/auth');
const logger = require('winston');

// Middleware d'authentification requis pour toutes les routes contacts
router.use(verifyToken);

/**
 * GET /api/contacts/check/:phoneNumber
 * Vérifie si un numéro existe sur WhatsApp
 */
router.get('/check/:phoneNumber', async (req, res) => {
    try {
        const { phoneNumber } = req.params;

        // Nettoyage basique du numéro (supprime +, espaces, etc)
        const cleanNumber = phoneNumber.replace(/\D/g, '');

        if (!cleanNumber) {
            return res.status(400).json({
                success: false,
                error: 'Invalid phone number format'
            });
        }

        // Récupérer le provider actif via le manager
        const provider = providerManager.getActiveProvider();

        if (!provider) {
            return res.status(503).json({
                success: false,
                error: 'No active provider available'
            });
        }

        // Utiliser la fonction du provider pour vérifier
        // La plupart des providers (Baileys/Meta) ont une méthode pour ça
        // Si baileys: onJidExists ou similaire
        let exists = false;
        let name = null;
        let jid = null;

        if (provider.getProviderName() === 'baileys') {
            // Implémentation via la méthode du provider
            try {
                const result = await provider.checkNumberExists(cleanNumber);
                exists = result.exists;
                jid = result.jid;
            } catch (err) {
                logger.warn(`Failed to check number on Baileys: ${err.message}`);
            }
        } else {
            // Fallback ou Meta provider (à implémenter si besoin)
            // Pour l'instant on suppose que si le format est bon, on tente
            exists = true;
            jid = cleanNumber;
        }

        if (exists) {
            // Tenter de récupérer le nom/info si possible (optionnel)
            // const contact = await provider.getContact(jid);
            // if (contact) name = contact.name || contact.notify || null;
        }

        res.json({
            success: true,
            exists: exists,
            jid: jid,
            name: name,
            phoneNumber: cleanNumber
        });

    } catch (error) {
        console.error(`Error checking contact ${req.params.phoneNumber}:`, error); // Force log to stdout
        // logger.error(`Error checking contact ${req.params.phoneNumber}:`, error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
