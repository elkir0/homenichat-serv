const axios = require('axios');
const logger = require('winston');
const packageJson = require('../package.json');

/**
 * Service pour vérifier les mises à jour de Baileys
 */
class VersionCheckService {
    constructor() {
        this.currentVersion = packageJson.dependencies['@whiskeysockets/baileys'].replace('^', '');
        this.latestVersion = null;
        this.lastCheck = null;
        this.updateAvailable = false;
        this.checkInterval = 24 * 60 * 60 * 1000; // 24 heures
    }

    /**
     * Initialise le service
     */
    async initialize() {
        logger.info(`VersionCheckService initialized. Current Baileys version: ${this.currentVersion}`);

        // Premier test immédiat (non bloquant)
        this.checkLatestVersion().catch(err => logger.error('Initial version check failed:', err));

        // Planifier les vérifications régulières
        setInterval(() => {
            this.checkLatestVersion().catch(err => logger.error('Scheduled version check failed:', err));
        }, this.checkInterval);
    }

    /**
     * Vérifie la dernière version sur le registre npm
     */
    async checkLatestVersion() {
        try {
            const response = await axios.get('https://registry.npmjs.org/@whiskeysockets/baileys/latest');
            this.latestVersion = response.data.version;
            this.lastCheck = new Date();

            if (this.compareVersions(this.latestVersion, this.currentVersion) > 0) {
                this.updateAvailable = true;
                logger.warn(`🔥 Une nouvelle version de Baileys est disponible : ${this.latestVersion} (Actuelle: ${this.currentVersion})`);
                // Ici on pourrait envoyer une notif push à l'admin
            } else {
                this.updateAvailable = false;
                logger.info(`Baileys est à jour (${this.currentVersion})`);
            }

            return {
                current: this.currentVersion,
                latest: this.latestVersion,
                updateAvailable: this.updateAvailable,
                lastCheck: this.lastCheck
            };
        } catch (error) {
            logger.error('Erreur lors de la vérification de version Baileys:', error);
            throw error;
        }
    }

    /**
     * Compare deux versions sémantiques (v1 > v2 ?)
     */
    compareVersions(v1, v2) {
        const p1 = v1.split('.').map(Number);
        const p2 = v2.split('.').map(Number);

        for (let i = 0; i < Math.max(p1.length, p2.length); i++) {
            const n1 = p1[i] || 0;
            const n2 = p2[i] || 0;
            if (n1 > n2) return 1;
            if (n1 < n2) return -1;
        }
        return 0;
    }

    getStatus() {
        return {
            current: this.currentVersion,
            latest: this.latestVersion,
            updateAvailable: this.updateAvailable,
            lastCheck: this.lastCheck
        };
    }
}

module.exports = new VersionCheckService();
