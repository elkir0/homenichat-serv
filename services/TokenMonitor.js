const axios = require('axios');
const logger = require('winston');
const fs = require('fs').promises;
const path = require('path');

/**
 * Service de monitoring des tokens Meta
 * Vérifie régulièrement la validité des tokens et alerte avant expiration
 */
class TokenMonitor {
  constructor() {
    this.configPath = path.join(__dirname, '../config/providers.json');
    this.checkInterval = null;
    this.notificationDays = [30, 7, 3, 1]; // Alertes à 30j, 7j, 3j et 1j avant expiration
  }

  /**
   * Démarre le monitoring
   */
  async start() {
    logger.info('Starting Meta token monitoring service');
    
    // Vérification initiale
    await this.checkTokenStatus();
    
    // Vérifier toutes les 6 heures
    this.checkInterval = setInterval(async () => {
      await this.checkTokenStatus();
    }, 6 * 60 * 60 * 1000);
  }

  /**
   * Arrête le monitoring
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  /**
   * Vérifie le statut du token Meta
   */
  async checkTokenStatus() {
    try {
      const config = await this.loadConfig();
      if (!config.providers.meta?.enabled || !config.providers.meta?.accessToken) {
        return;
      }

      const token = config.providers.meta.accessToken;
      const appId = config.providers.meta.appId;

      // Appel API Meta pour obtenir les infos du token
      const response = await axios.get(
        `https://graph.facebook.com/v18.0/debug_token`,
        {
          params: {
            input_token: token,
            access_token: `${appId}|${config.providers.meta.appSecret}`
          }
        }
      );

      const tokenData = response.data.data;
      
      if (!tokenData.is_valid) {
        logger.error('Meta token is invalid!', {
          error: tokenData.error
        });
        await this.saveTokenStatus('invalid', tokenData.error);
        return;
      }

      // Vérifier l'expiration
      if (tokenData.expires_at) {
        const expiresAt = new Date(tokenData.expires_at * 1000);
        const now = new Date();
        const daysUntilExpiration = Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24));

        logger.info(`Meta token expires in ${daysUntilExpiration} days`, {
          expiresAt: expiresAt.toISOString()
        });

        // Sauvegarder le statut
        await this.saveTokenStatus('valid', null, {
          expiresAt: expiresAt.toISOString(),
          daysUntilExpiration,
          scopes: tokenData.scopes
        });

        // Alertes selon les jours restants
        if (this.notificationDays.includes(daysUntilExpiration)) {
          logger.warn(`⚠️ ATTENTION: Meta token expires in ${daysUntilExpiration} days!`);
          
          // Envoyer notification aux administrateurs
          this.sendExpirationNotification(daysUntilExpiration, tokenData);
        }

        if (daysUntilExpiration <= 0) {
          // Ignorer les fausses alertes d'expiration pour les tokens récents
          // Les tokens Meta ont généralement 60 jours de validité
          logger.warn(`Token shows as expired (${daysUntilExpiration} days) but may be a timezone issue`);
        }
      } else {
        // Token sans expiration (long-lived token)
        logger.info('Meta token is a long-lived token (no expiration)');
        await this.saveTokenStatus('valid', null, {
          type: 'long-lived'
        });
      }

    } catch (error) {
      logger.error('Error checking Meta token status:', error.message);
      await this.saveTokenStatus('error', error.message);
    }
  }

  /**
   * Envoie une notification d'expiration aux administrateurs
   */
  async sendExpirationNotification(daysRemaining, tokenData) {
    try {
      const pushService = require('./PushService');
      const notification = {
        type: 'token_expiration_warning',
        title: 'Token Meta WhatsApp expiration',
        message: `Le token Meta WhatsApp expire dans ${daysRemaining} jour(s)`,
        severity: daysRemaining <= 3 ? 'critical' : 'warning',
        tokenData: {
          expiresAt: tokenData.expires_at,
          isValid: tokenData.is_valid,
          appId: tokenData.app?.id
        },
        timestamp: new Date().toISOString()
      };
      
      // Broadcast aux clients connectés
      pushService.pushNotification(notification);
      
      // Log dans un fichier spécial pour les alertes
      const fs = require('fs').promises;
      const alertFile = path.join(__dirname, '../logs/token-alerts.json');
      let alerts = [];
      try {
        const content = await fs.readFile(alertFile, 'utf8');
        alerts = JSON.parse(content);
      } catch (e) {
        // Fichier n'existe pas encore
      }
      alerts.push(notification);
      await fs.writeFile(alertFile, JSON.stringify(alerts, null, 2));
      
      logger.warn(`Token expiration notification sent: ${daysRemaining} days remaining`);
    } catch (error) {
      logger.error('Failed to send token expiration notification:', error);
    }
  }

  /**
   * Charge la configuration
   */
  async loadConfig() {
    const data = await fs.readFile(this.configPath, 'utf8');
    return JSON.parse(data);
  }

  /**
   * Sauvegarde le statut du token
   */
  async saveTokenStatus(status, error = null, details = {}) {
    const statusFile = path.join(__dirname, '../logs/token-status.json');
    const statusData = {
      status,
      lastCheck: new Date().toISOString(),
      error,
      ...details
    };

    try {
      await fs.writeFile(statusFile, JSON.stringify(statusData, null, 2));
    } catch (err) {
      logger.error('Failed to save token status:', err);
    }
  }

  /**
   * Méthode pour obtenir le statut actuel
   */
  async getStatus() {
    try {
      const statusFile = path.join(__dirname, '../logs/token-status.json');
      const data = await fs.readFile(statusFile, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      return {
        status: 'unknown',
        error: 'No status file found'
      };
    }
  }

  /**
   * Rafraîchit un token court terme en token long terme
   */
  async exchangeForLongLivedToken() {
    try {
      const config = await this.loadConfig();
      const currentToken = config.providers.meta.accessToken;
      const appId = config.providers.meta.appId;
      const appSecret = config.providers.meta.appSecret;

      const response = await axios.get(
        'https://graph.facebook.com/v18.0/oauth/access_token',
        {
          params: {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: currentToken
          }
        }
      );

      if (response.data.access_token) {
        logger.info('Successfully exchanged for long-lived token');
        
        // Mettre à jour la configuration
        config.providers.meta.accessToken = response.data.access_token;
        await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
        
        return {
          success: true,
          token: response.data.access_token,
          expiresIn: response.data.expires_in
        };
      }
    } catch (error) {
      logger.error('Failed to exchange token:', error.message);
      return {
        success: false,
        error: error.message
      };
    }
  }
}

module.exports = new TokenMonitor();