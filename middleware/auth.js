const jwt = require('jsonwebtoken');
const db = require('../services/DatabaseService');

// Clé secrète pour JWT (à mettre dans les variables d'environnement)
const JWT_SECRET = process.env.JWT_SECRET || 'lekip-chat-secret-key-change-this-in-production';

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
  isAdmin,
  requireAdmin: isAdmin, // Alias pour la cohérence
  verifyWebSocketToken,
  JWT_SECRET
};