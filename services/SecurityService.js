/**
 * SecurityService - Service de sécurité centralisé
 *
 * Gère:
 * - Rate limiting avancé par catégorie
 * - Audit logging de toutes les actions
 * - Gestion des tokens API
 * - Whitelist/Blacklist IP
 * - Support 2FA (TOTP)
 */

const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const crypto = require('crypto');
const { EventEmitter } = require('events');

class SecurityService extends EventEmitter {
  constructor(database, config = {}) {
    super();
    this.db = database;
    this.config = {
      // Rate limits par défaut (requêtes/fenêtre)
      rateLimits: {
        login: { windowMs: 60 * 1000, max: 5 },           // 5 tentatives/min
        api: { windowMs: 60 * 1000, max: 100 },           // 100 req/min
        sms: { windowMs: 60 * 1000, max: 10 },            // 10 SMS/min
        webhook: { windowMs: 60 * 1000, max: 1000 },      // 1000 webhooks/min
        admin: { windowMs: 60 * 1000, max: 30 },          // 30 req/min admin
      },
      // Durée de validité des tokens
      tokenExpiry: {
        session: 30 * 24 * 60 * 60 * 1000,  // 30 jours
        api: 365 * 24 * 60 * 60 * 1000,     // 1 an
        refresh: 90 * 24 * 60 * 60 * 1000,  // 90 jours
      },
      // 2FA
      twoFactorIssuer: 'Homenichat',
      // IP filtering
      enableIpFilter: false,
      ipWhitelist: [],
      ipBlacklist: [],
      ...config,
    };

    this.rateLimiters = new Map();
    this.initDatabase();
  }

  /**
   * Initialise les tables de sécurité
   */
  initDatabase() {
    if (!this.db) return;

    // Table des tokens API
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_tokens (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT UNIQUE NOT NULL,
        permissions TEXT DEFAULT '[]',
        last_used_at INTEGER,
        expires_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        revoked INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Table d'audit
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        user_id INTEGER,
        username TEXT,
        action TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        resource TEXT,
        details TEXT,
        ip_address TEXT,
        user_agent TEXT,
        success INTEGER DEFAULT 1
      )
    `);

    // Index pour les recherches d'audit
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_category ON audit_log(category);
    `);

    // Table 2FA
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_2fa (
        user_id INTEGER PRIMARY KEY,
        secret TEXT NOT NULL,
        enabled INTEGER DEFAULT 0,
        backup_codes TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    // Table IP filter
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ip_filter (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('whitelist', 'blacklist')),
        reason TEXT,
        expires_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // Table des sessions actives
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        token_hash TEXT NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        last_activity INTEGER,
        expires_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    console.log('[Security] Database tables initialized');
  }

  // ==================== Rate Limiting ====================

  /**
   * Crée un rate limiter pour une catégorie
   */
  createRateLimiter(category) {
    const config = this.config.rateLimits[category] || this.config.rateLimits.api;

    return rateLimit({
      windowMs: config.windowMs,
      max: config.max,
      message: {
        error: 'Too many requests',
        category,
        retryAfter: Math.ceil(config.windowMs / 1000),
      },
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => {
        // Utiliser user ID si authentifié, sinon IP
        return req.user?.id ? `user:${req.user.id}` : req.ip;
      },
      handler: (req, res, next, options) => {
        this.logAction(null, 'rate_limit_exceeded', {
          category,
          ip: req.ip,
          path: req.path,
        });
        res.status(429).json(options.message);
      },
    });
  }

  /**
   * Récupère ou crée un rate limiter
   */
  getRateLimiter(category) {
    if (!this.rateLimiters.has(category)) {
      this.rateLimiters.set(category, this.createRateLimiter(category));
    }
    return this.rateLimiters.get(category);
  }

  /**
   * Middleware rate limit
   */
  rateLimit(category) {
    return this.getRateLimiter(category);
  }

  // ==================== Audit Logging ====================

  /**
   * Enregistre une action dans le journal d'audit
   */
  async logAction(userId, action, details = {}, req = null) {
    if (!this.db) return;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO audit_log (user_id, username, action, category, resource, details, ip_address, user_agent, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        userId || null,
        details.username || null,
        action,
        details.category || 'general',
        details.resource || null,
        JSON.stringify(details),
        req?.ip || details.ip || null,
        req?.get('user-agent') || details.userAgent || null,
        details.success !== false ? 1 : 0
      );

      // Émettre un événement pour le monitoring temps réel
      this.emit('audit', {
        userId,
        action,
        details,
        timestamp: Date.now(),
      });

    } catch (error) {
      console.error('[Security] Audit log error:', error.message);
    }
  }

  /**
   * Récupère les logs d'audit avec filtres
   */
  async getAuditLogs(filters = {}) {
    if (!this.db) return [];

    const conditions = ['1=1'];
    const params = [];

    if (filters.userId) {
      conditions.push('user_id = ?');
      params.push(filters.userId);
    }

    if (filters.action) {
      conditions.push('action LIKE ?');
      params.push(`%${filters.action}%`);
    }

    if (filters.category) {
      conditions.push('category = ?');
      params.push(filters.category);
    }

    if (filters.startDate) {
      conditions.push('timestamp >= ?');
      params.push(filters.startDate);
    }

    if (filters.endDate) {
      conditions.push('timestamp <= ?');
      params.push(filters.endDate);
    }

    if (filters.success !== undefined) {
      conditions.push('success = ?');
      params.push(filters.success ? 1 : 0);
    }

    const limit = filters.limit || 100;
    const offset = filters.offset || 0;

    const query = `
      SELECT * FROM audit_log
      WHERE ${conditions.join(' AND ')}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    try {
      return this.db.prepare(query).all(...params);
    } catch (error) {
      console.error('[Security] Get audit logs error:', error.message);
      return [];
    }
  }

  // ==================== Token Management ====================

  /**
   * Génère un nouveau token API
   */
  async generateApiToken(userId, name, permissions = [], expiresInDays = 365) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(token);
    const id = crypto.randomUUID();
    const expiresAt = Date.now() + (expiresInDays * 24 * 60 * 60 * 1000);

    if (this.db) {
      const stmt = this.db.prepare(`
        INSERT INTO api_tokens (id, user_id, name, token_hash, permissions, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      stmt.run(id, userId, name, tokenHash, JSON.stringify(permissions), expiresAt);
    }

    await this.logAction(userId, 'api_token_created', {
      category: 'security',
      resource: `token:${id}`,
      tokenName: name,
    });

    // Retourner le token en clair (une seule fois)
    return {
      id,
      token: `hc_${token}`, // Préfixe pour identifier les tokens Homenichat
      name,
      permissions,
      expiresAt,
    };
  }

  /**
   * Valide un token API
   */
  async validateApiToken(token) {
    if (!token || !token.startsWith('hc_')) {
      return null;
    }

    const rawToken = token.slice(3); // Retirer le préfixe
    const tokenHash = this.hashToken(rawToken);

    if (!this.db) return null;

    try {
      const stmt = this.db.prepare(`
        SELECT t.*, u.username
        FROM api_tokens t
        JOIN users u ON t.user_id = u.id
        WHERE t.token_hash = ? AND t.revoked = 0 AND (t.expires_at IS NULL OR t.expires_at > ?)
      `);

      const tokenData = stmt.get(tokenHash, Date.now());

      if (tokenData) {
        // Mettre à jour last_used_at
        this.db.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?')
          .run(Date.now(), tokenData.id);

        return {
          id: tokenData.id,
          userId: tokenData.user_id,
          username: tokenData.username,
          name: tokenData.name,
          permissions: JSON.parse(tokenData.permissions || '[]'),
        };
      }

      return null;
    } catch (error) {
      console.error('[Security] Token validation error:', error.message);
      return null;
    }
  }

  /**
   * Révoque un token
   */
  async revokeToken(tokenId, userId) {
    if (!this.db) return false;

    try {
      const stmt = this.db.prepare('UPDATE api_tokens SET revoked = 1 WHERE id = ?');
      const result = stmt.run(tokenId);

      if (result.changes > 0) {
        await this.logAction(userId, 'api_token_revoked', {
          category: 'security',
          resource: `token:${tokenId}`,
        });
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Security] Token revoke error:', error.message);
      return false;
    }
  }

  /**
   * Liste les tokens d'un utilisateur
   */
  async listUserTokens(userId) {
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT id, name, permissions, last_used_at, expires_at, created_at, revoked
        FROM api_tokens
        WHERE user_id = ?
        ORDER BY created_at DESC
      `);

      return stmt.all(userId).map(t => ({
        ...t,
        permissions: JSON.parse(t.permissions || '[]'),
      }));
    } catch (error) {
      console.error('[Security] List tokens error:', error.message);
      return [];
    }
  }

  /**
   * Hash un token
   */
  hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // ==================== IP Filtering ====================

  /**
   * Vérifie si une IP est autorisée
   */
  async checkIpAccess(ip) {
    if (!this.config.enableIpFilter) {
      return { allowed: true };
    }

    // Vérifier la blacklist d'abord
    if (this.config.ipBlacklist.includes(ip)) {
      return { allowed: false, reason: 'IP blacklisted (config)' };
    }

    // Vérifier la whitelist config
    if (this.config.ipWhitelist.length > 0 && !this.config.ipWhitelist.includes(ip)) {
      return { allowed: false, reason: 'IP not in whitelist' };
    }

    // Vérifier la base de données
    if (this.db) {
      const blacklisted = this.db.prepare(`
        SELECT * FROM ip_filter
        WHERE ip_address = ? AND type = 'blacklist'
        AND (expires_at IS NULL OR expires_at > ?)
      `).get(ip, Date.now());

      if (blacklisted) {
        return { allowed: false, reason: blacklisted.reason || 'IP blacklisted' };
      }
    }

    return { allowed: true };
  }

  /**
   * Ajoute une IP à la liste
   */
  async addIpToList(ip, type, reason = null, expiresInHours = null) {
    if (!this.db) return false;

    const expiresAt = expiresInHours
      ? Date.now() + (expiresInHours * 60 * 60 * 1000)
      : null;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO ip_filter (ip_address, type, reason, expires_at)
        VALUES (?, ?, ?, ?)
      `);

      stmt.run(ip, type, reason, expiresAt);
      return true;
    } catch (error) {
      console.error('[Security] Add IP to list error:', error.message);
      return false;
    }
  }

  /**
   * Retire une IP de la liste
   */
  async removeIpFromList(ip, type) {
    if (!this.db) return false;

    try {
      const stmt = this.db.prepare('DELETE FROM ip_filter WHERE ip_address = ? AND type = ?');
      stmt.run(ip, type);
      return true;
    } catch (error) {
      console.error('[Security] Remove IP from list error:', error.message);
      return false;
    }
  }

  // ==================== 2FA (Two-Factor Authentication) ====================

  /**
   * Génère un secret 2FA pour un utilisateur
   */
  async generate2FASecret(userId, username) {
    const secret = speakeasy.generateSecret({
      name: `${this.config.twoFactorIssuer}:${username}`,
      issuer: this.config.twoFactorIssuer,
      length: 32,
    });

    // Stocker le secret (non activé encore)
    if (this.db) {
      const existing = this.db.prepare('SELECT * FROM user_2fa WHERE user_id = ?').get(userId);

      if (existing) {
        this.db.prepare('UPDATE user_2fa SET secret = ?, enabled = 0 WHERE user_id = ?')
          .run(secret.base32, userId);
      } else {
        this.db.prepare('INSERT INTO user_2fa (user_id, secret) VALUES (?, ?)')
          .run(userId, secret.base32);
      }
    }

    // Générer le QR code
    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    return {
      secret: secret.base32,
      qrCode: qrCodeUrl,
      otpauthUrl: secret.otpauth_url,
    };
  }

  /**
   * Active le 2FA après vérification du premier code
   */
  async enable2FA(userId, code) {
    if (!this.db) return { success: false, error: 'Database not available' };

    const userData = this.db.prepare('SELECT secret FROM user_2fa WHERE user_id = ?').get(userId);

    if (!userData) {
      return { success: false, error: '2FA not configured' };
    }

    const verified = speakeasy.totp.verify({
      secret: userData.secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (verified) {
      // Générer des codes de backup
      const backupCodes = this.generateBackupCodes();

      this.db.prepare('UPDATE user_2fa SET enabled = 1, backup_codes = ? WHERE user_id = ?')
        .run(JSON.stringify(backupCodes.map(c => this.hashToken(c))), userId);

      await this.logAction(userId, '2fa_enabled', { category: 'security' });

      return { success: true, backupCodes };
    }

    return { success: false, error: 'Invalid code' };
  }

  /**
   * Vérifie un code 2FA
   */
  async verify2FACode(userId, code) {
    if (!this.db) return false;

    const userData = this.db.prepare('SELECT * FROM user_2fa WHERE user_id = ? AND enabled = 1').get(userId);

    if (!userData) return false;

    // Vérifier le code TOTP
    const verified = speakeasy.totp.verify({
      secret: userData.secret,
      encoding: 'base32',
      token: code,
      window: 1,
    });

    if (verified) return true;

    // Vérifier les codes de backup
    const backupCodes = JSON.parse(userData.backup_codes || '[]');
    const codeHash = this.hashToken(code);
    const codeIndex = backupCodes.indexOf(codeHash);

    if (codeIndex !== -1) {
      // Supprimer le code utilisé
      backupCodes.splice(codeIndex, 1);
      this.db.prepare('UPDATE user_2fa SET backup_codes = ? WHERE user_id = ?')
        .run(JSON.stringify(backupCodes), userId);

      await this.logAction(userId, '2fa_backup_code_used', { category: 'security' });
      return true;
    }

    return false;
  }

  /**
   * Vérifie si un utilisateur a le 2FA activé
   */
  async has2FAEnabled(userId) {
    if (!this.db) return false;

    const userData = this.db.prepare('SELECT enabled FROM user_2fa WHERE user_id = ?').get(userId);
    return userData?.enabled === 1;
  }

  /**
   * Désactive le 2FA
   */
  async disable2FA(userId) {
    if (!this.db) return false;

    this.db.prepare('DELETE FROM user_2fa WHERE user_id = ?').run(userId);
    await this.logAction(userId, '2fa_disabled', { category: 'security' });
    return true;
  }

  /**
   * Génère des codes de backup
   */
  generateBackupCodes(count = 10) {
    const codes = [];
    for (let i = 0; i < count; i++) {
      codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
    }
    return codes;
  }

  // ==================== Session Management ====================

  /**
   * Enregistre une nouvelle session
   */
  async registerSession(userId, tokenHash, req) {
    if (!this.db) return null;

    const sessionId = crypto.randomUUID();
    const expiresAt = Date.now() + this.config.tokenExpiry.session;

    try {
      const stmt = this.db.prepare(`
        INSERT INTO active_sessions (id, user_id, token_hash, ip_address, user_agent, last_activity, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        sessionId,
        userId,
        tokenHash,
        req?.ip || null,
        req?.get('user-agent') || null,
        Date.now(),
        expiresAt
      );

      return sessionId;
    } catch (error) {
      console.error('[Security] Register session error:', error.message);
      return null;
    }
  }

  /**
   * Liste les sessions actives d'un utilisateur
   */
  async getActiveSessions(userId) {
    if (!this.db) return [];

    try {
      const stmt = this.db.prepare(`
        SELECT id, ip_address, user_agent, created_at, last_activity
        FROM active_sessions
        WHERE user_id = ? AND expires_at > ?
        ORDER BY last_activity DESC
      `);

      return stmt.all(userId, Date.now());
    } catch (error) {
      console.error('[Security] Get sessions error:', error.message);
      return [];
    }
  }

  /**
   * Révoque une session
   */
  async revokeSession(sessionId, userId) {
    if (!this.db) return false;

    try {
      const stmt = this.db.prepare('DELETE FROM active_sessions WHERE id = ? AND user_id = ?');
      const result = stmt.run(sessionId, userId);

      if (result.changes > 0) {
        await this.logAction(userId, 'session_revoked', {
          category: 'security',
          resource: `session:${sessionId}`,
        });
        return true;
      }

      return false;
    } catch (error) {
      console.error('[Security] Revoke session error:', error.message);
      return false;
    }
  }

  /**
   * Révoque toutes les sessions d'un utilisateur (sauf la courante)
   */
  async revokeAllSessions(userId, exceptSessionId = null) {
    if (!this.db) return false;

    try {
      let stmt;
      if (exceptSessionId) {
        stmt = this.db.prepare('DELETE FROM active_sessions WHERE user_id = ? AND id != ?');
        stmt.run(userId, exceptSessionId);
      } else {
        stmt = this.db.prepare('DELETE FROM active_sessions WHERE user_id = ?');
        stmt.run(userId);
      }

      await this.logAction(userId, 'all_sessions_revoked', { category: 'security' });
      return true;
    } catch (error) {
      console.error('[Security] Revoke all sessions error:', error.message);
      return false;
    }
  }

  /**
   * Nettoie les sessions expirées
   */
  async cleanupExpiredSessions() {
    if (!this.db) return;

    try {
      this.db.prepare('DELETE FROM active_sessions WHERE expires_at < ?').run(Date.now());
      this.db.prepare('DELETE FROM api_tokens WHERE revoked = 1 OR (expires_at IS NOT NULL AND expires_at < ?)').run(Date.now());
      this.db.prepare('DELETE FROM ip_filter WHERE expires_at IS NOT NULL AND expires_at < ?').run(Date.now());
    } catch (error) {
      console.error('[Security] Cleanup error:', error.message);
    }
  }

  // ==================== Dashboard Stats ====================

  /**
   * Récupère les statistiques de sécurité
   */
  async getSecurityStats() {
    if (!this.db) return null;

    const now = Date.now();
    const last24h = now - (24 * 60 * 60 * 1000);
    const lastWeek = now - (7 * 24 * 60 * 60 * 1000);

    try {
      return {
        activeSessions: this.db.prepare('SELECT COUNT(*) as count FROM active_sessions WHERE expires_at > ?').get(now)?.count || 0,
        activeTokens: this.db.prepare('SELECT COUNT(*) as count FROM api_tokens WHERE revoked = 0 AND (expires_at IS NULL OR expires_at > ?)').get(now)?.count || 0,
        failedLogins24h: this.db.prepare("SELECT COUNT(*) as count FROM audit_log WHERE action = 'login' AND success = 0 AND timestamp > ?").get(last24h)?.count || 0,
        rateLimitHits24h: this.db.prepare("SELECT COUNT(*) as count FROM audit_log WHERE action = 'rate_limit_exceeded' AND timestamp > ?").get(last24h)?.count || 0,
        auditEventsLastWeek: this.db.prepare('SELECT COUNT(*) as count FROM audit_log WHERE timestamp > ?').get(lastWeek)?.count || 0,
        blockedIps: this.db.prepare("SELECT COUNT(*) as count FROM ip_filter WHERE type = 'blacklist' AND (expires_at IS NULL OR expires_at > ?)").get(now)?.count || 0,
        users2FAEnabled: this.db.prepare('SELECT COUNT(*) as count FROM user_2fa WHERE enabled = 1').get()?.count || 0,
      };
    } catch (error) {
      console.error('[Security] Get stats error:', error.message);
      return null;
    }
  }
}

module.exports = SecurityService;
