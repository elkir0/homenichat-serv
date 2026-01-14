/**
 * Security Middlewares - Protection des routes
 *
 * Middlewares:
 * - rateLimitMiddleware: Limite les requêtes par catégorie
 * - auditMiddleware: Log automatique des actions
 * - ipFilterMiddleware: Filtre IP whitelist/blacklist
 * - inputValidationMiddleware: Sanitize les inputs
 * - apiTokenMiddleware: Authentification par token API
 * - adminOnlyMiddleware: Restriction aux admins
 * - csrfProtection: Protection CSRF (pour formulaires web)
 */

const helmet = require('helmet');
const { validationResult, body, param, query } = require('express-validator');

/**
 * Middleware de rate limiting par catégorie
 */
function createRateLimitMiddleware(securityService, category = 'api') {
  return securityService.rateLimit(category);
}

/**
 * Middleware d'audit automatique
 */
function auditMiddleware(securityService, actionPrefix = '') {
  return async (req, res, next) => {
    // Capturer le temps de début
    const startTime = Date.now();

    // Intercepter la fin de la requête
    const originalEnd = res.end;
    res.end = function(...args) {
      const duration = Date.now() - startTime;

      // Construire l'action
      const action = actionPrefix
        ? `${actionPrefix}:${req.method.toLowerCase()}`
        : `${req.method.toLowerCase()}:${req.path}`;

      // Log l'action
      securityService.logAction(
        req.user?.id || null,
        action,
        {
          category: 'api',
          resource: req.path,
          method: req.method,
          statusCode: res.statusCode,
          duration,
          query: Object.keys(req.query).length > 0 ? req.query : undefined,
          success: res.statusCode < 400,
          username: req.user?.username,
        },
        req
      );

      originalEnd.apply(res, args);
    };

    next();
  };
}

/**
 * Middleware de filtrage IP
 */
function ipFilterMiddleware(securityService) {
  return async (req, res, next) => {
    const result = await securityService.checkIpAccess(req.ip);

    if (!result.allowed) {
      await securityService.logAction(null, 'ip_blocked', {
        category: 'security',
        ip: req.ip,
        reason: result.reason,
        success: false,
      });

      return res.status(403).json({
        error: 'Access denied',
        reason: result.reason,
      });
    }

    next();
  };
}

/**
 * Middleware de validation des inputs
 */
function inputValidationMiddleware(validations = []) {
  return async (req, res, next) => {
    // Exécuter toutes les validations
    await Promise.all(validations.map(validation => validation.run(req)));

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        error: 'Validation failed',
        details: errors.array(),
      });
    }

    next();
  };
}

/**
 * Middleware d'authentification par token API
 */
function apiTokenMiddleware(securityService) {
  return async (req, res, next) => {
    // Vérifier le header Authorization
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return next(); // Pas de token, continuer (d'autres middlewares vérifieront l'auth)
    }

    // Format: Bearer hc_xxxxx ou juste hc_xxxxx
    let token = authHeader;
    if (authHeader.startsWith('Bearer ')) {
      token = authHeader.slice(7);
    }

    if (token.startsWith('hc_')) {
      const tokenData = await securityService.validateApiToken(token);

      if (tokenData) {
        req.user = {
          id: tokenData.userId,
          username: tokenData.username,
          role: 'api',
          tokenId: tokenData.id,
          permissions: tokenData.permissions,
        };
        req.authMethod = 'api_token';
      } else {
        return res.status(401).json({ error: 'Invalid or expired API token' });
      }
    }

    next();
  };
}

/**
 * Middleware admin only
 */
function adminOnlyMiddleware(securityService) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (req.user.role !== 'admin') {
      await securityService.logAction(req.user.id, 'admin_access_denied', {
        category: 'security',
        resource: req.path,
        success: false,
        username: req.user.username,
      }, req);

      return res.status(403).json({ error: 'Admin access required' });
    }

    next();
  };
}

/**
 * Middleware de vérification des permissions
 */
function permissionMiddleware(securityService, requiredPermission) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Les admins ont toutes les permissions
    if (req.user.role === 'admin') {
      return next();
    }

    // Vérifier les permissions du token API
    if (req.user.permissions && req.user.permissions.includes(requiredPermission)) {
      return next();
    }

    await securityService.logAction(req.user.id, 'permission_denied', {
      category: 'security',
      resource: req.path,
      requiredPermission,
      success: false,
      username: req.user.username,
    }, req);

    return res.status(403).json({
      error: 'Permission denied',
      required: requiredPermission,
    });
  };
}

/**
 * Middleware 2FA requis
 */
function require2FAMiddleware(securityService) {
  return async (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Vérifier si l'utilisateur a le 2FA activé
    const has2FA = await securityService.has2FAEnabled(req.user.id);

    if (has2FA && !req.session?.twoFactorVerified) {
      return res.status(403).json({
        error: '2FA verification required',
        code: '2FA_REQUIRED',
      });
    }

    next();
  };
}

/**
 * Middleware de protection CSRF (pour admin web)
 */
function csrfMiddleware() {
  return (req, res, next) => {
    // Skip pour les requêtes GET, HEAD, OPTIONS
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    // Skip pour les tokens API
    if (req.authMethod === 'api_token') {
      return next();
    }

    // Vérifier le header CSRF
    const csrfHeader = req.headers['x-csrf-token'];
    const csrfCookie = req.cookies?.csrf_token;

    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
      return res.status(403).json({ error: 'CSRF token mismatch' });
    }

    next();
  };
}

/**
 * Middleware de nettoyage des inputs
 */
function sanitizeMiddleware() {
  return (req, res, next) => {
    // Fonction de nettoyage récursive
    const sanitize = (obj) => {
      if (typeof obj === 'string') {
        // Supprimer les caractères de contrôle
        return obj.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
      }
      if (Array.isArray(obj)) {
        return obj.map(sanitize);
      }
      if (obj && typeof obj === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          // Nettoyer aussi les clés
          const cleanKey = key.replace(/[\x00-\x1F\x7F]/g, '');
          result[cleanKey] = sanitize(value);
        }
        return result;
      }
      return obj;
    };

    if (req.body) {
      req.body = sanitize(req.body);
    }
    if (req.query) {
      req.query = sanitize(req.query);
    }
    if (req.params) {
      req.params = sanitize(req.params);
    }

    next();
  };
}

/**
 * Configuration Helmet sécurisée
 */
function helmetConfig() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"], // Nécessaire pour certains frameworks UI
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "wss:", "https:"],
        mediaSrc: ["'self'", "blob:"],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false, // Nécessaire pour certaines ressources
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });
}

/**
 * Middleware de logging des erreurs de sécurité
 */
function securityErrorHandler(securityService) {
  return (err, req, res, next) => {
    // Log l'erreur
    securityService.logAction(req.user?.id, 'security_error', {
      category: 'security',
      error: err.message,
      stack: err.stack,
      path: req.path,
      success: false,
    }, req);

    // Ne pas exposer les détails en production
    const message = process.env.NODE_ENV === 'production'
      ? 'An error occurred'
      : err.message;

    res.status(500).json({ error: message });
  };
}

/**
 * Validateurs communs pour express-validator
 */
const validators = {
  // ID numérique
  id: param('id').isInt({ min: 1 }).withMessage('Invalid ID'),

  // UUID
  uuid: param('id').isUUID().withMessage('Invalid UUID'),

  // Email
  email: body('email').isEmail().normalizeEmail().withMessage('Invalid email'),

  // Mot de passe fort
  password: body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters')
    .matches(/[a-z]/).withMessage('Password must contain a lowercase letter')
    .matches(/[A-Z]/).withMessage('Password must contain an uppercase letter')
    .matches(/[0-9]/).withMessage('Password must contain a number'),

  // Numéro de téléphone
  phone: body('phone')
    .matches(/^\+?[0-9]{10,15}$/)
    .withMessage('Invalid phone number'),

  // Pagination
  pagination: [
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
  ],

  // Token 2FA
  twoFactorCode: body('code')
    .isLength({ min: 6, max: 8 })
    .isAlphanumeric()
    .withMessage('Invalid 2FA code'),
};

module.exports = {
  createRateLimitMiddleware,
  auditMiddleware,
  ipFilterMiddleware,
  inputValidationMiddleware,
  apiTokenMiddleware,
  adminOnlyMiddleware,
  permissionMiddleware,
  require2FAMiddleware,
  csrfMiddleware,
  sanitizeMiddleware,
  helmetConfig,
  securityErrorHandler,
  validators,
};
