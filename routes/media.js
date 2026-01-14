const express = require('express');
const router = express.Router();
const multer = require('multer');
const mediaStorageService = require('../services/MediaStorageService');
const providerManager = require('../services/ProviderManager');
const { verifyToken } = require('../middleware/auth');
const logger = require('../utils/logger');
const audioConverter = require('../utils/audioConverter');

// Configuration de multer pour l'upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 100 * 1024 * 1024 // 100 MB max
  },
  fileFilter: (req, file, cb) => {
    // Vérifier les types de fichiers autorisés
    const allowedMimes = [
      // Images
      'image/jpeg', 'image/png', 'image/gif', 'image/webp',
      // Audio
      'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/amr', 'audio/webm', 'audio/aac',
      // Video
      'video/mp4', 'video/3gpp',
      // Documents
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    ];
    
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Type de fichier non supporté'));
    }
  }
});

// Route de test sans authentification (temporaire)
router.post('/test-upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }

    const { chatId, messageText } = req.body;
    
    // Stocker le fichier
    const storedMedia = await mediaStorageService.storeMedia(req.file.buffer, {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      chatId: chatId || 'test',
      messageId: `test_${Date.now()}`,
      userId: 1
    });

    res.json({
      success: true,
      media: storedMedia
    });
  } catch (error) {
    console.error('Test upload error:', error);
    res.status(500).json({ error: 'Erreur lors du test upload' });
  }
});

// Route pour uploader un média
router.post('/upload', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier fourni' });
    }
    
    const { chatId, messageId } = req.body;
    
    if (!chatId) {
      return res.status(400).json({ error: 'chatId requis' });
    }
    
    // Stocker le fichier localement
    const mediaInfo = await mediaStorageService.storeMedia(req.file.buffer, {
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      chatId: chatId,
      messageId: messageId,
      userId: req.userId
    });
    
    // Si on utilise Meta, uploader aussi sur leurs serveurs
    const provider = providerManager.getActiveProvider();
    if (provider.name === 'meta') {
      try {
        logger.info('Uploading media to Meta...');
        
        // Adapter le type MIME pour Meta si nécessaire
        let mimeType = req.file.mimetype;
        let fileName = req.file.originalname;
        
        // Meta supporte: audio/aac, audio/mp4, audio/mpeg, audio/amr, audio/ogg
        // Si c'est webm ou faux mp4, on doit convertir
        let uploadBuffer = req.file.buffer;
        
        if (mimeType === 'audio/webm' || (mimeType === 'audio/mp4' && req.file.originalname.includes('voice-message'))) {
          logger.info('Converting WebM/fake MP4 audio to MP3 for Meta compatibility...');
          
          try {
            // Convertir en MP3 avec FFmpeg
            const converted = await audioConverter.convertToMp3(req.file.buffer);
            uploadBuffer = converted.buffer;
            mimeType = converted.mimeType;
            fileName = fileName.replace(/\.(webm|mp4|ogg)$/, '.mp3');
            
            logger.info(`Audio converted successfully to ${mimeType}`);
          } catch (conversionError) {
            logger.error('Audio conversion failed:', conversionError);
            // Fallback: essayer avec le format original
            logger.warn('Falling back to original format');
          }
        }
        
        logger.info(`Uploading audio to Meta with type: ${mimeType}`);
        
        const uploadResult = await provider.uploadMedia(uploadBuffer, {
          fileName: fileName,
          mimeType: mimeType
        });
        
        if (uploadResult.success && uploadResult.mediaId) {
          // Mettre à jour avec l'ID Meta
          mediaInfo.metaMediaId = uploadResult.mediaId;
          logger.info(`Media uploaded to Meta with ID: ${uploadResult.mediaId}`);
        } else {
          logger.error('Meta upload failed:', uploadResult.error);
          throw new Error(uploadResult.error || 'Meta upload failed');
        }
      } catch (error) {
        logger.error('Failed to upload to Meta:', error);
        // On ne continue pas si l'upload Meta échoue pour éviter les erreurs
        return res.status(500).json({ 
          error: 'Erreur lors de l\'upload vers Meta: ' + error.message 
        });
      }
    }
    
    res.json({
      success: true,
      media: mediaInfo
    });
  } catch (error) {
    logger.error('Upload error:', error);
    res.status(500).json({ error: 'Erreur lors de l\'upload' });
  }
});

// Route pour récupérer un média - PUBLIC pour permettre l'affichage des images
// TODO: Ajouter une vérification de token dans l'URL ou un système de session
router.get('/:mediaId', async (req, res) => {
  try {
    const { mediaId } = req.params;
    
    // Récupérer le média
    const { data, metadata } = await mediaStorageService.getMedia(mediaId);
    
    // Définir les headers appropriés
    res.set({
      'Content-Type': metadata.mime_type,
      'Content-Length': metadata.size,
      'Content-Disposition': `inline; filename="${metadata.file_name}"`,
      'Cache-Control': 'private, max-age=3600'
    });
    
    // Envoyer le fichier
    res.send(data);
  } catch (error) {
    logger.error('Media retrieval error:', error);
    
    if (error.message === 'Media not found') {
      res.status(404).json({ error: 'Média non trouvé' });
    } else if (error.message === 'Media expired') {
      res.status(410).json({ error: 'Média expiré' });
    } else {
      res.status(500).json({ error: 'Erreur lors de la récupération du média' });
    }
  }
});

// Route pour télécharger un média depuis Meta
router.post('/download-meta/:metaMediaId', verifyToken, async (req, res) => {
  try {
    const { metaMediaId } = req.params;
    const { chatId, messageId } = req.body;
    
    const provider = providerManager.getActiveProvider();
    if (provider.name !== 'meta') {
      return res.status(400).json({ error: 'Provider non compatible' });
    }
    
    // Télécharger et stocker
    const mediaInfo = await mediaStorageService.downloadFromMeta(
      metaMediaId, 
      provider
    );
    
    res.json({
      success: true,
      media: mediaInfo
    });
  } catch (error) {
    logger.error('Meta download error:', error);
    res.status(500).json({ error: 'Erreur lors du téléchargement' });
  }
});

// Route pour obtenir les stats de stockage
router.get('/stats/storage', verifyToken, async (req, res) => {
  try {
    const stats = await mediaStorageService.getStorageStats();
    res.json(stats);
  } catch (error) {
    logger.error('Stats error:', error);
    res.status(500).json({ error: 'Erreur lors de la récupération des stats' });
  }
});

// Route pour nettoyer les médias expirés (admin only)
router.post('/cleanup', verifyToken, async (req, res) => {
  try {
    // Vérifier les droits admin
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ 
        error: 'Accès refusé. Droits administrateur requis.' 
      });
    }
    
    const deletedCount = await mediaStorageService.cleanupExpiredMedia();
    
    res.json({
      success: true,
      deletedCount: deletedCount
    });
  } catch (error) {
    logger.error('Cleanup error:', error);
    res.status(500).json({ error: 'Erreur lors du nettoyage' });
  }
});

module.exports = router;