const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs').promises;
const path = require('path');
const logger = require('winston');
const crypto = require('crypto');

/**
 * Gestionnaire des médias pour WhatsApp Cloud API
 * Gère l'upload, le download et le cache des médias
 */
class MediaManager {
  constructor(config) {
    this.config = config;
    this.apiVersion = config.apiVersion || 'v18.0';
    this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
    
    // Cache des URLs de médias (expire après 1 heure)
    this.mediaUrlCache = new Map();
    this.cacheExpiry = 60 * 60 * 1000; // 1 heure
    
    // Limites de taille par type
    this.sizeLimits = {
      image: 5 * 1024 * 1024,      // 5MB
      video: 16 * 1024 * 1024,     // 16MB
      audio: 16 * 1024 * 1024,     // 16MB
      document: 100 * 1024 * 1024, // 100MB
      sticker: 100 * 1024          // 100KB
    };
    
    // Types MIME supportés
    this.supportedMimeTypes = {
      image: ['image/jpeg', 'image/png'],
      video: ['video/mp4', 'video/3gpp'],
      audio: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
      document: ['application/pdf', 'application/vnd.ms-powerpoint', 
                 'application/msword', 'application/vnd.ms-excel',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      sticker: ['image/webp']
    };
    
    // Statistiques
    this.stats = {
      uploaded: 0,
      downloaded: 0,
      cacheHits: 0,
      errors: 0
    };
  }

  /**
   * Upload un média vers WhatsApp
   * @param {string|Buffer} source - Chemin du fichier ou Buffer
   * @param {string} type - Type de média (image, video, audio, document, sticker)
   * @param {Object} options - Options supplémentaires
   * @returns {Promise<{success: boolean, mediaId?: string, error?: string}>}
   */
  async uploadMedia(source, type, options = {}) {
    try {
      let fileBuffer;
      let mimeType;
      let filename;
      
      // Obtenir le buffer et le type MIME
      if (Buffer.isBuffer(source)) {
        fileBuffer = source;
        mimeType = options.mimeType || this.detectMimeType(fileBuffer);
        filename = options.filename || `file_${Date.now()}`;
      } else if (typeof source === 'string') {
        if (source.startsWith('http')) {
          // Télécharger depuis une URL
          const downloadResult = await this.downloadFromUrl(source);
          fileBuffer = downloadResult.buffer;
          mimeType = downloadResult.mimeType;
          filename = downloadResult.filename;
        } else {
          // Lire depuis le système de fichiers
          fileBuffer = await fs.readFile(source);
          mimeType = this.getMimeTypeFromFile(source);
          filename = path.basename(source);
        }
      } else {
        throw new Error('Source invalide: doit être un Buffer, une URL ou un chemin de fichier');
      }
      
      // Valider le type et la taille
      const validation = this.validateMedia(fileBuffer, type, mimeType);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error
        };
      }
      
      // Créer le FormData
      const formData = new FormData();
      formData.append('messaging_product', 'whatsapp');
      formData.append('file', fileBuffer, {
        filename: filename,
        contentType: mimeType
      });
      
      // Upload vers Meta
      const response = await axios.post(
        `${this.baseURL}/${this.config.phoneNumberId}/media`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${this.config.accessToken}`
          },
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
      
      this.stats.uploaded++;
      
      return {
        success: true,
        mediaId: response.data.id,
        hash: this.calculateHash(fileBuffer)
      };
    } catch (error) {
      logger.error('Erreur upload média:', error);
      this.stats.errors++;
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Télécharge un média depuis WhatsApp
   * @param {string} mediaId - ID du média
   * @param {Object} options - Options (savePath, returnBuffer)
   * @returns {Promise<{success: boolean, data?: Buffer|string, error?: string}>}
   */
  async downloadMedia(mediaId, options = {}) {
    try {
      // Vérifier le cache
      const cachedUrl = this.getCachedUrl(mediaId);
      let mediaUrl = cachedUrl;
      
      if (!mediaUrl) {
        // Obtenir l'URL du média
        const urlResult = await this.getMediaUrl(mediaId);
        if (!urlResult.success) {
          return urlResult;
        }
        mediaUrl = urlResult.url;
      }
      
      // Télécharger le média
      const response = await axios.get(mediaUrl, {
        headers: {
          'Authorization': `Bearer ${this.config.accessToken}`
        },
        responseType: 'arraybuffer'
      });
      
      const buffer = Buffer.from(response.data);
      this.stats.downloaded++;
      
      // Sauvegarder si demandé
      if (options.savePath) {
        await fs.writeFile(options.savePath, buffer);
        return {
          success: true,
          data: options.savePath
        };
      }
      
      return {
        success: true,
        data: options.returnBuffer ? buffer : buffer.toString('base64')
      };
    } catch (error) {
      logger.error('Erreur download média:', error);
      this.stats.errors++;
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Obtient l'URL d'un média
   * @param {string} mediaId - ID du média
   * @returns {Promise<{success: boolean, url?: string, error?: string}>}
   */
  async getMediaUrl(mediaId) {
    try {
      const response = await axios.get(
        `${this.baseURL}/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      const url = response.data.url;
      
      // Mettre en cache
      this.cacheMediaUrl(mediaId, url);
      
      return {
        success: true,
        url: url
      };
    } catch (error) {
      logger.error('Erreur récupération URL média:', error);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Supprime un média
   * @param {string} mediaId - ID du média
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteMedia(mediaId) {
    try {
      await axios.delete(
        `${this.baseURL}/${mediaId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      // Retirer du cache
      this.mediaUrlCache.delete(mediaId);
      
      return { success: true };
    } catch (error) {
      logger.error('Erreur suppression média:', error);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Valide un média
   * @param {Buffer} buffer - Buffer du média
   * @param {string} type - Type de média
   * @param {string} mimeType - Type MIME
   * @returns {Object} {valid: boolean, error?: string}
   */
  validateMedia(buffer, type, mimeType) {
    // Vérifier la taille
    const sizeLimit = this.sizeLimits[type];
    if (sizeLimit && buffer.length > sizeLimit) {
      return {
        valid: false,
        error: `Fichier trop grand. Limite: ${this.formatSize(sizeLimit)}, Taille: ${this.formatSize(buffer.length)}`
      };
    }
    
    // Vérifier le type MIME
    const supportedTypes = this.supportedMimeTypes[type];
    if (supportedTypes && !supportedTypes.includes(mimeType)) {
      return {
        valid: false,
        error: `Type MIME non supporté: ${mimeType}. Types acceptés: ${supportedTypes.join(', ')}`
      };
    }
    
    // Validations spécifiques
    if (type === 'sticker') {
      // Les stickers doivent être en WebP
      if (mimeType !== 'image/webp') {
        return {
          valid: false,
          error: 'Les stickers doivent être au format WebP'
        };
      }
    }
    
    return { valid: true };
  }

  /**
   * Télécharge depuis une URL
   * @param {string} url - URL du fichier
   * @returns {Promise<{buffer: Buffer, mimeType: string, filename: string}>}
   */
  async downloadFromUrl(url) {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      maxContentLength: 100 * 1024 * 1024 // 100MB max
    });
    
    const buffer = Buffer.from(response.data);
    const mimeType = response.headers['content-type'] || 'application/octet-stream';
    const filename = this.extractFilenameFromUrl(url) || `download_${Date.now()}`;
    
    return { buffer, mimeType, filename };
  }

  /**
   * Détecte le type MIME d'un buffer
   * @param {Buffer} buffer - Buffer à analyser
   * @returns {string} Type MIME
   */
  detectMimeType(buffer) {
    // Signatures de fichiers communes
    const signatures = {
      'ffd8ff': 'image/jpeg',
      '89504e47': 'image/png',
      '47494638': 'image/gif',
      '52494646': 'image/webp',
      '00000020667479704d503432': 'video/mp4',
      '1a45dfa3': 'video/webm',
      '494433': 'audio/mpeg',
      '4f676753': 'audio/ogg',
      '25504446': 'application/pdf'
    };
    
    const hex = buffer.toString('hex', 0, 12);
    
    for (const [sig, mime] of Object.entries(signatures)) {
      if (hex.startsWith(sig.toLowerCase())) {
        return mime;
      }
    }
    
    return 'application/octet-stream';
  }

  /**
   * Obtient le type MIME d'un fichier
   * @param {string} filepath - Chemin du fichier
   * @returns {string} Type MIME
   */
  getMimeTypeFromFile(filepath) {
    const ext = path.extname(filepath).toLowerCase().slice(1);
    const mimeTypes = {
      // Images
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      // Vidéos
      'mp4': 'video/mp4',
      '3gp': 'video/3gpp',
      // Audio
      'mp3': 'audio/mpeg',
      'aac': 'audio/aac',
      'ogg': 'audio/ogg',
      'amr': 'audio/amr',
      // Documents
      'pdf': 'application/pdf',
      'doc': 'application/msword',
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'xls': 'application/vnd.ms-excel',
      'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'ppt': 'application/vnd.ms-powerpoint',
      'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    
    return mimeTypes[ext] || 'application/octet-stream';
  }

  /**
   * Calcule le hash SHA256 d'un buffer
   * @param {Buffer} buffer - Buffer à hasher
   * @returns {string} Hash SHA256
   */
  calculateHash(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  /**
   * Extrait le nom de fichier d'une URL
   * @param {string} url - URL
   * @returns {string} Nom de fichier
   */
  extractFilenameFromUrl(url) {
    try {
      const urlObj = new URL(url);
      const pathname = urlObj.pathname;
      return path.basename(pathname) || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Met en cache une URL de média
   * @param {string} mediaId - ID du média
   * @param {string} url - URL du média
   */
  cacheMediaUrl(mediaId, url) {
    this.mediaUrlCache.set(mediaId, {
      url: url,
      expires: Date.now() + this.cacheExpiry
    });
  }

  /**
   * Obtient une URL depuis le cache
   * @param {string} mediaId - ID du média
   * @returns {string|null} URL ou null si pas en cache/expiré
   */
  getCachedUrl(mediaId) {
    const cached = this.mediaUrlCache.get(mediaId);
    
    if (!cached) {
      return null;
    }
    
    if (Date.now() > cached.expires) {
      this.mediaUrlCache.delete(mediaId);
      return null;
    }
    
    this.stats.cacheHits++;
    return cached.url;
  }

  /**
   * Formate une taille en octets
   * @param {number} bytes - Taille en octets
   * @returns {string} Taille formatée
   */
  formatSize(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    
    while (size > 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    
    return `${size.toFixed(2)} ${units[unitIndex]}`;
  }

  /**
   * Nettoie le cache expiré
   */
  cleanupCache() {
    const now = Date.now();
    
    for (const [mediaId, cached] of this.mediaUrlCache) {
      if (now > cached.expires) {
        this.mediaUrlCache.delete(mediaId);
      }
    }
  }

  /**
   * Obtient les statistiques
   * @returns {Object} Statistiques
   */
  getStats() {
    return {
      ...this.stats,
      cacheSize: this.mediaUrlCache.size
    };
  }
}

module.exports = MediaManager;