const jwt = require('jsonwebtoken');
const db = require('../services/DatabaseService');

// Clé secrète pour JWT (à mettre dans les variables d'environnement)
const JWT_SECRET = process.env.JWT_SECRET || 'homenichat-secret-key-change-this-in-production';

// Homenichat Cloud provisioning server URL
const CLOUD_PROVISIONING_URL = process.env.CLOUD_PROVISIONING_URL || 'https://relay.homenichat.com';

// Cache for validated cloud tokens (5 min TTL)
const cloudTokenCache = new Map();
const CLOUD_TOKEN_CACHE_TTL = 5 * 60 * 1000;

/**
 * Validate a Homenichat Cloud token (hc_xxx) against the provisioning server
 */
async function validateCloudToken(token) {
  // Check cache first
  const cached = cloudTokenCache.get(token);
  if (cached && Date.now() - cached.timestamp < CLOUD_TOKEN_CACHE_TTL) {
    console.log('[Auth] Cloud token found in cache, user:', cached.user.username);
    return cached.user;
  }

  const validationUrl = `${CLOUD_PROVISIONING_URL}/api/auth/validate-token`;
  console.log('[Auth] Validating cloud token against:', validationUrl);
  console.log('[Auth] Token prefix:', token.substring(0, 10) + '...');

  try {
    const response = await fetch(validationUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    console.log('[Auth] Validation response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[Auth] Validation failed:', response.status, errorText);
      return null;
    }

    const data = await response.json();
    console.log('[Auth] Validation response:', JSON.stringify(data));

    if (!data.valid) {
      console.error('[Auth] Token marked as invalid by provisioning server');
      return null;
    }

    // Create a pseudo-user for cloud-authenticated requests
    const cloudUser = {
      id: `cloud_${data.userId}`,
      username: `cloud_user_${data.userId.substring(0, 8)}`,
      role: 'user', // Cloud users get standard user role
      isCloudUser: true,
      cloudUserId: data.userId,
      services: data.services,
    };

    // Cache the result
    cloudTokenCache.set(token, { user: cloudUser, timestamp: Date.now() });
    console.log('[Auth] Cloud token validated and cached for user:', cloudUser.username);

    return cloudUser;
  } catch (error) {
    console.error('[Auth] Cloud token validation error:', error.message);
    console.error('[Auth] Full error:', error);
    return null;
  }
}

// Générer un token JWT
const generateToken = (user) => {
  // Token valable 30 jours pour le confort mobile
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
};

// Middleware pour vérifier le token
const verifyToken = async (req, res, next) => {
  try {
    // Récupérer le token depuis le header Authorization
    const authHeader = req.headers.authorization;
    let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    // Support token dans query params (nécessaire pour SSE/EventSource qui ne supporte pas les headers)
    if (!token && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      return res.status(401).json({ error: 'Token manquant' });
    }

    // Check if it's a Homenichat Cloud token (hc_xxx)
    if (token.startsWith('hc_')) {
      const cloudUser = await validateCloudToken(token);
      if (cloudUser) {
        req.user = cloudUser;
        return next();
      }
      return res.status(401).json({ error: 'Cloud token invalide' });
    }

    // Vérifier si le token est dans la base (session valide)
    const session = db.getSession(token);
    if (!session) {
      // Support legacy JWT only if needed, but better to enforce session
      // Pour l'instant on continue de vérifier le JWT si pas de session trouvée (transition)
    }

    // Vérifier le token JWT
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
      if (err) {
        return res.status(401).json({ error: 'Token invalide' });
      }

      // Récupérer l'utilisateur depuis la base
      const user = db.getUserById(decoded.id);
      if (!user) {
        return res.status(401).json({ error: 'Utilisateur non trouvé' });
      }

      // Ajouter l'utilisateur à la requête
      req.user = user;
      next();
    });
  } catch (error) {
    console.error('Erreur auth:', error);
    res.status(500).json({ error: 'Erreur serveur' });
  }
};

// Middleware pour vérifier si l'utilisateur est admin
const isAdmin = (req, res, next) => {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Accès refusé - Admin uniquement' });
  }
};

// Middleware optionnel - parse le token si présent mais n'échoue pas si absent
// Utile pour les endpoints qui fonctionnent avec ou sans auth
const optionalVerifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    let token = authHeader && authHeader.split(' ')[1];

    if (!token && req.query.token) {
      token = req.query.token;
    }

    if (!token) {
      // Pas de token = pas d'utilisateur, mais on continue
      req.user = null;
      return next();
    }

    // Check if it's a Homenichat Cloud token (hc_xxx)
    if (token.startsWith('hc_')) {
      const cloudUser = await validateCloudToken(token);
      req.user = cloudUser || null;
      return next();
    }

    // Vérifier le token JWT
    jwt.verify(token, JWT_SECRET, async (err, decoded) => {
      if (err) {
        // Token invalide = pas d'utilisateur, mais on continue
        req.user = null;
        return next();
      }

      // Récupérer l'utilisateur depuis la base
      const user = db.getUserById(decoded.id);
      req.user = user || null;
      next();
    });
  } catch (error) {
    // Erreur = pas d'utilisateur, mais on continue
    req.user = null;
    next();
  }
};

// Middleware pour WebSocket
const verifyWebSocketToken = async (token) => {
  try {
    if (!token) return null;

    // Vérifier le token JWT
    const decoded = jwt.verify(token, JWT_SECRET);

    // Récupérer l'utilisateur
    const user = db.getUserById(decoded.id);
    return user;
  } catch (error) {
    console.error('Erreur WebSocket auth:', error);
    return null;
  }
};

module.exports = {
  generateToken,
  verifyToken,
  optionalVerifyToken,
  validateCloudToken,
  isAdmin,
  requireAdmin: isAdmin, // Alias pour la cohérence
  verifyWebSocketToken,
  JWT_SECRET
};