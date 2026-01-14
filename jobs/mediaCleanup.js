const mediaStorageService = require('../services/MediaStorageService');
const logger = require('../utils/logger');

class MediaCleanupJob {
  constructor() {
    this.isRunning = false;
    this.interval = null;
  }

  /**
   * Démarre le job de nettoyage
   * @param {number} intervalHours - Intervalle en heures (par défaut 24h)
   */
  start(intervalHours = 24) {
    if (this.interval) {
      logger.warn('MediaCleanupJob already running');
      return;
    }

    // Exécuter immédiatement au démarrage
    this.execute();

    // Puis planifier l'exécution périodique
    this.interval = setInterval(() => {
      this.execute();
    }, intervalHours * 60 * 60 * 1000);

    logger.info(`MediaCleanupJob started with ${intervalHours}h interval`);
  }

  /**
   * Arrête le job
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      logger.info('MediaCleanupJob stopped');
    }
  }

  /**
   * Exécute le nettoyage
   */
  async execute() {
    if (this.isRunning) {
      logger.warn('MediaCleanupJob already executing, skipping...');
      return;
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info('Starting media cleanup...');
      
      // Nettoyer les fichiers expirés
      const deletedCount = await mediaStorageService.cleanupExpiredMedia();
      
      // Obtenir les stats après nettoyage
      const stats = await mediaStorageService.getStorageStats();
      
      const duration = Date.now() - startTime;
      
      logger.info(`Media cleanup completed in ${duration}ms`, {
        deletedFiles: deletedCount,
        remainingFiles: stats?.totalFiles || 0,
        storageUsedMB: stats?.totalSizeMB || 0
      });

      // Si l'utilisation dépasse un certain seuil, alerter
      if (stats && stats.totalSizeMB > 5000) { // 5GB
        logger.warn(`High storage usage: ${stats.totalSizeMB}MB`);
      }

    } catch (error) {
      logger.error('Media cleanup failed:', error);
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Obtient le statut du job
   */
  getStatus() {
    return {
      running: this.isRunning,
      scheduled: !!this.interval
    };
  }
}

module.exports = new MediaCleanupJob();