const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const db = require('./DatabaseService');

class MediaStorageService {
  constructor() {
    this.mediaDir = path.join(__dirname, '../../media');
    this.initializeStorage();
  }

  async initializeStorage() {
    try {
      // Créer le répertoire media s'il n'existe pas
      await fs.mkdir(this.mediaDir, { recursive: true });

      // Créer les sous-répertoires par type
      const subdirs = ['images', 'audio', 'video', 'documents', 'temp'];
      for (const subdir of subdirs) {
        await fs.mkdir(path.join(this.mediaDir, subdir), { recursive: true });
      }

      // Créer la table media si elle n'existe pas
      this.initializeDatabase();

      logger.info('MediaStorageService initialized');
    } catch (error) {
      logger.error('Failed to initialize MediaStorageService:', error);
    }
  }

  initializeDatabase() {
    try {
      const createTableSQL = `
        CREATE TABLE IF NOT EXISTS media (
          id TEXT PRIMARY KEY,
          chat_id TEXT NOT NULL,
          message_id TEXT,
          file_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size INTEGER NOT NULL,
          meta_media_id TEXT,
          meta_url TEXT,
          created_at INTEGER NOT NULL,
          expires_at INTEGER,
          accessed_at INTEGER,
          user_id INTEGER NOT NULL DEFAULT 1
        )
      `;

      const createIndices = [
        `CREATE INDEX IF NOT EXISTS idx_media_chat_id ON media(chat_id)`,
        `CREATE INDEX IF NOT EXISTS idx_media_expires_at ON media(expires_at)`,
        `CREATE INDEX IF NOT EXISTS idx_media_message_id ON media(message_id)`
      ];

      db.prepare(createTableSQL).run();
      createIndices.forEach(sql => db.prepare(sql).run());
    } catch (error) {
      logger.error('Failed to init media DB:', error);
    }
  }

  /**
   * Stocke un fichier média localement
   * @param {Buffer|Stream} fileData - Données du fichier
   * @param {Object} metadata - Métadonnées du fichier
   * @returns {Object} Informations sur le fichier stocké
   */
  async storeMedia(fileData, metadata) {
    try {
      const {
        fileName,
        mimeType,
        chatId,
        messageId,
        userId = 1,
        metaMediaId = null,
        metaUrl = null
      } = metadata;

      // Générer un ID unique pour le fichier
      const mediaId = crypto.randomBytes(16).toString('hex');

      // Déterminer le type de média et l'extension
      const mediaType = this.getMediaType(mimeType);
      const extension = this.getFileExtension(fileName, mimeType);
      const safeFileName = `${mediaId}${extension}`;

      // Chemin complet du fichier
      const filePath = path.join(this.mediaDir, mediaType, safeFileName);

      // Écrire le fichier
      if (Buffer.isBuffer(fileData)) {
        await fs.writeFile(filePath, fileData);
      } else {
        // Si c'est un stream, le gérer différemment
        const chunks = [];
        for await (const chunk of fileData) {
          chunks.push(chunk);
        }
        await fs.writeFile(filePath, Buffer.concat(chunks));
      }

      // Obtenir la taille du fichier
      const stats = await fs.stat(filePath);

      // Calculer la date d'expiration (3 mois par défaut)
      const expiresAt = Date.now() + (90 * 24 * 60 * 60 * 1000);

      // Stocker les métadonnées en base
      const insertSQL = `
        INSERT INTO media (
          id, chat_id, message_id, file_name, file_path, 
          mime_type, size, meta_media_id, meta_url,
          created_at, expires_at, user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `;

      db.prepare(insertSQL).run(
        mediaId,
        chatId,
        messageId,
        fileName,
        path.relative(this.mediaDir, filePath),
        mimeType,
        stats.size,
        metaMediaId,
        metaUrl,
        Date.now(),
        expiresAt,
        userId
      );

      logger.info(`Media stored: ${mediaId} (${fileName})`);

      return {
        id: mediaId,
        fileName: fileName,
        filePath: filePath,
        mimeType: mimeType,
        size: stats.size,
        url: `/api/media/${mediaId}`
      };
    } catch (error) {
      logger.error('Failed to store media:', error);
      throw error;
    }
  }

  /**
   * Récupère un fichier média
   * @param {string} mediaId - ID du média
   * @returns {Object} Données du fichier et métadonnées
   */
  async getMedia(mediaId) {
    try {
      // Récupérer les métadonnées
      const selectSQL = `
        SELECT * FROM media WHERE id = ?
      `;

      const media = db.prepare(selectSQL).get(mediaId);

      if (!media) {
        throw new Error('Media not found');
      }

      // Vérifier si le fichier n'a pas expiré
      if (media.expires_at && media.expires_at < Date.now()) {
        throw new Error('Media expired');
      }

      // Construire le chemin complet
      const fullPath = path.join(this.mediaDir, media.file_path);

      // Vérifier que le fichier existe
      await fs.access(fullPath);

      // Mettre à jour la date d'accès
      db.prepare('UPDATE media SET accessed_at = ? WHERE id = ?').run(Date.now(), mediaId);

      // Lire le fichier
      const fileData = await fs.readFile(fullPath);

      return {
        data: fileData,
        metadata: media
      };
    } catch (error) {
      logger.error('Failed to get media:', error);
      throw error;
    }
  }

  /**
   * Télécharge un média depuis l'API Meta
   * @param {string} mediaId - ID du média Meta
   * @param {Object} metaProvider - Instance du provider Meta
   * @param {Object} options - Options supplémentaires {chatId, messageId}
   * @returns {Object} Informations sur le fichier téléchargé
   */
  async downloadFromMeta(mediaId, metaProvider, options = {}) {
    try {
      logger.info(`Starting download from Meta for media ID: ${mediaId}`);

      // Obtenir l'URL du média avec retry
      let mediaInfo;
      let attempts = 0;
      const maxAttempts = 3;

      while (attempts < maxAttempts) {
        try {
          mediaInfo = await metaProvider.getMediaUrl(mediaId);
          break;
        } catch (error) {
          attempts++;
          logger.warn(`Attempt ${attempts}/${maxAttempts} failed for media ${mediaId}:`, error.message);

          // Vérifier si c'est une erreur de token expiré
          if (error.response?.data?.error?.code === 190) {
            throw new Error('Meta access token expired. Please renew the token.');
          }

          if (attempts >= maxAttempts) throw error;

          // Attendre avant de réessayer (backoff exponentiel)
          await new Promise(resolve => setTimeout(resolve, 1000 * attempts));
        }
      }

      logger.info(`Media info received - type: ${typeof mediaInfo}, value:`, JSON.stringify(mediaInfo));

      // Validation et normalisation améliorée
      if (!mediaInfo) {
        throw new Error('No media info received from Meta API');
      }

      // Si c'est une string directe (URL), la normaliser
      if (typeof mediaInfo === 'string') {
        logger.info('Media info is a direct URL string, normalizing...');
        mediaInfo = {
          url: mediaInfo,
          mimeType: 'application/octet-stream'
        };
      }

      // Si c'est un Buffer ou un objet Buffer-like, le convertir
      if (mediaInfo instanceof Buffer || (typeof mediaInfo === 'object' && mediaInfo.type === 'Buffer')) {
        logger.info('Media info is a Buffer, converting to string...');
        const urlString = Buffer.from(mediaInfo.data || mediaInfo).toString('utf8').trim();

        // Nettoyer l'URL des guillemets éventuels
        const cleanUrl = urlString.replace(/^["']|["']$/g, '');

        mediaInfo = {
          url: cleanUrl,
          mimeType: 'application/octet-stream'
        };
      }

      // Vérification finale de l'URL
      if (!mediaInfo.url) {
        logger.error('Media info structure:', JSON.stringify(mediaInfo));
        throw new Error(`Invalid media info structure. Expected URL but got: ${typeof mediaInfo.url}`);
      }

      logger.info(`Downloading media from URL: ${mediaInfo.url.substring(0, 100)}...`);

      // Télécharger le fichier
      const mediaData = await metaProvider.downloadMedia(mediaInfo.url);

      logger.info(`Media downloaded successfully, size: ${mediaData.buffer.length} bytes`);

      // Stocker localement
      return await this.storeMedia(mediaData.buffer, {
        fileName: mediaData.fileName || `media_${mediaId}`,
        mimeType: mediaData.mimeType || mediaInfo.mimeType || 'application/octet-stream',
        chatId: options.chatId,
        messageId: options.messageId,
        metaMediaId: mediaId,
        metaUrl: mediaInfo.url,
        userId: options.userId || 1
      });
    } catch (error) {
      logger.error('Failed to download from Meta:', error.message);
      logger.error('Error stack:', error.stack);

      // Ajouter des informations contextuelles à l'erreur
      error.mediaId = mediaId;
      error.provider = 'meta';

      throw error;
    }
  }

  /**
   * Nettoie les fichiers expirés
   */
  async cleanupExpiredMedia() {
    try {
      // Récupérer les médias expirés
      const selectSQL = `
        SELECT id, file_path FROM media 
        WHERE expires_at < ? 
        LIMIT 100
      `;

      const expiredMedia = db.prepare(selectSQL).all(Date.now());

      let deletedCount = 0;

      for (const media of expiredMedia) {
        try {
          // Supprimer le fichier
          const fullPath = path.join(this.mediaDir, media.file_path);
          await fs.unlink(fullPath);

          // Supprimer de la base
          db.prepare('DELETE FROM media WHERE id = ?').run(media.id);

          deletedCount++;
        } catch (error) {
          logger.warn(`Failed to delete expired media ${media.id}:`, error);
        }
      }

      if (deletedCount > 0) {
        logger.info(`Cleaned up ${deletedCount} expired media files`);
      }

      return deletedCount;
    } catch (error) {
      logger.error('Failed to cleanup expired media:', error);
      return 0;
    }
  }

  /**
   * Obtient les statistiques d'utilisation du stockage
   */
  async getStorageStats() {
    try {
      const stats = db.prepare(`
        SELECT 
          COUNT(*) as total_files,
          SUM(size) as total_size,
          COUNT(CASE WHEN mime_type LIKE 'image/%' THEN 1 END) as images_count,
          COUNT(CASE WHEN mime_type LIKE 'audio/%' THEN 1 END) as audio_count,
          COUNT(CASE WHEN mime_type LIKE 'video/%' THEN 1 END) as video_count,
          COUNT(CASE WHEN mime_type NOT LIKE 'image/%' 
                     AND mime_type NOT LIKE 'audio/%' 
                     AND mime_type NOT LIKE 'video/%' THEN 1 END) as documents_count
        FROM media
      `).get();

      return {
        totalFiles: stats.total_files || 0,
        totalSize: stats.total_size || 0,
        totalSizeMB: Math.round((stats.total_size || 0) / (1024 * 1024) * 100) / 100,
        byType: {
          images: stats.images_count || 0,
          audio: stats.audio_count || 0,
          video: stats.video_count || 0,
          documents: stats.documents_count || 0
        }
      };
    } catch (error) {
      logger.error('Failed to get storage stats:', error);
      return null;
    }
  }

  /**
   * Détermine le type de média basé sur le MIME type
   */
  getMediaType(mimeType) {
    if (mimeType.startsWith('image/')) return 'images';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    return 'documents';
  }

  /**
   * Obtient l'extension du fichier
   */
  getFileExtension(fileName, mimeType) {
    // D'abord essayer d'extraire depuis le nom de fichier
    if (fileName) {
      const ext = path.extname(fileName);
      if (ext) return ext;
    }

    // Sinon, déduire depuis le MIME type
    const mimeToExt = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'audio/mpeg': '.mp3',
      'audio/ogg': '.ogg',
      'audio/wav': '.wav',
      'audio/amr': '.amr',
      'video/mp4': '.mp4',
      'video/3gpp': '.3gp',
      'application/pdf': '.pdf',
      'application/msword': '.doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
      'application/vnd.ms-excel': '.xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx'
    };

    return mimeToExt[mimeType] || '.bin';
  }

  /**
   * Configure la durée de vie des médias
   */
  async setMediaLifetime(days) {
    // Stocker la configuration (à implémenter avec le système de config)
    logger.info(`Media lifetime set to ${days} days`);
  }
}

module.exports = new MediaStorageService();