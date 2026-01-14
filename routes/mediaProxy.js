const express = require('express');
const axios = require('axios');
const router = express.Router();

// Proxy pour télécharger les médias WhatsApp
router.post('/proxy-media', async (req, res) => {
  try {
    const { url, mimetype } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: 'URL manquante' });
    }
    
    // Vérifier si l'URL est un fichier .enc (chiffré)
    if (url.includes('.enc')) {
      return res.status(400).json({ 
        error: 'Fichier chiffré',
        message: 'Les fichiers .enc nécessitent un déchiffrement'
      });
    }
    
    console.log('Tentative de téléchargement média:', { url: url.substring(0, 50) + '...', mimetype });
    
    // Télécharger le média depuis l'URL WhatsApp
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'image/*,video/*,audio/*',
        'Referer': 'https://web.whatsapp.com/'
      },
      maxRedirects: 5
    });
    
    // Définir les headers appropriés
    res.set({
      'Content-Type': mimetype || response.headers['content-type'] || 'image/jpeg',
      'Content-Length': response.data.length,
      'Cache-Control': 'public, max-age=3600'
    });
    
    // Envoyer l'image
    res.send(response.data);
    
  } catch (error) {
    console.error('Erreur proxy média:', error.message);
    
    // Si c'est une erreur 403 ou 404, l'URL a probablement expiré
    if (error.response?.status === 403 || error.response?.status === 404) {
      res.status(403).json({ 
        error: 'URL expirée ou inaccessible',
        message: 'L\'URL du média a expiré ou nécessite une authentification.'
      });
    } else {
      res.status(500).json({ 
        error: 'Erreur téléchargement média',
        message: error.message,
        status: error.response?.status
      });
    }
  }
});

module.exports = router;