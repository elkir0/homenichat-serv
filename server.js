const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const WebSocket = require('ws');
const http = require('http');
const path = require('path');
require('dotenv').config();

// Import des routes
const authRoutes = require('./routes/auth');
const proxyRoutes = require('./routes/proxy-refactored');
const mediaProxyRoutes = require('./routes/mediaProxy');
const providersRoutes = require('./routes/providers');
const providersV2Routes = require('./routes/providers-v2');
const chatsRoutes = require('./routes/chats');
const mediaRoutes = require('./routes/media');
const sessionsRoutes = require('./routes/sessions');
const callHistoryRoutes = require('./routes/call-history');
const cdrRoutes = require('./routes/cdr');
const configRoutes = require('./routes/config');
const mobileCompatRoutes = require('./routes/mobile-compat');
const { router: adminRouter, initAdminRoutes } = require('./routes/admin');
const { router: discoveryRouter, initDiscoveryRoutes } = require('./routes/discovery');
// const MessagePoller = require('./messagePoller');
// const { logWebhook } = require('./webhookDebugger');
const { verifyToken, verifyWebSocketToken } = require('./middleware/auth');
const providerManager = require('./services/ProviderManager');
const sessionManager = require('./services/SessionManager');
const pushService = require('./services/PushService');
const mediaCleanupJob = require('./jobs/mediaCleanup');
const webSocketManager = require('./services/WebSocketManager');
const VoipProvider = require('./providers/voip/VoipProvider');
const freepbxAmi = require('./services/FreePBXAmiService');
const SecurityService = require('./services/SecurityService');
const {
  auditMiddleware,
  ipFilterMiddleware,
  apiTokenMiddleware,
  adminOnlyMiddleware,
  sanitizeMiddleware,
} = require('./middleware/security');

// Instance du service de sécurité (sera initialisée avec la DB)
let securityService = null;
// Temporairement désactivé pour debug
// const database = require('./database');

// Configuration
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3001;

// Trust proxy pour éviter les erreurs de rate limiting
app.set('trust proxy', 1);

// Middleware de sécurité
// Permissive pour installation HTTP locale - avertissement: sans HTTPS, certaines fonctions PWA ne marcheront pas
const isHttps = process.env.HTTPS === 'true';
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false, // Ne pas utiliser les défauts de helmet (qui incluent upgrade-insecure-requests)
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:", "http:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      workerSrc: ["'self'", "blob:"],
      // upgradeInsecureRequests is intentionally omitted for HTTP deployments
      ...(isHttps ? { upgradeInsecureRequests: [] } : {})
    }
  },
  // Disable HSTS for HTTP deployments (causes SSL errors on local network)
  hsts: isHttps,
  // Disable cross-origin policies for local development
  crossOriginOpenerPolicy: false,
  crossOriginResourcePolicy: false,
  originAgentCluster: false
}));

// Initialiser le provider VoIP
const voipProvider = new VoipProvider({
  server: process.env.VOIP_SIP_SERVER,
  domain: process.env.VOIP_DOMAIN,
  extension: process.env.VOIP_USER,
  password: process.env.VOIP_PASSWORD
});

// Autres middlewares
app.use(compression());
app.use(cors({
  origin: process.env.FRONTEND_URL || ['http://localhost:3000', 'http://localhost:8090'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Middleware de nettoyage des inputs
app.use(sanitizeMiddleware());

// Rate limiting - désactivé temporairement pour debug
// TODO: Réactiver après résolution du problème 429
/*
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limite chaque IP à 1000 requêtes par fenêtre
  message: 'Trop de requêtes, veuillez réessayer plus tard.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.headers['x-forwarded-for'] || req.ip || req.connection.remoteAddress;
  },
  skip: (req) => {
    // Pas de rate limiting pour les routes d'authentification
    return req.path.startsWith('/api/auth/');
  }
});
app.use('/api/', limiter);
*/

// Logging
const winston = require('winston');
const chatStorage = require('./services/ChatStorageServicePersistent');
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.json(),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Middleware pour gérer la session active
app.use((req, res, next) => {
  // Si pas de session spécifiée, utiliser la session active
  if (!req.headers['x-session-id'] && sessionManager.activeSessionId) {
    req.sessionId = sessionManager.activeSessionId;
  } else if (req.headers['x-session-id']) {
    req.sessionId = req.headers['x-session-id'];
  }
  next();
});

// Routes publiques (authentification)
app.use('/api/auth', authRoutes);
app.use('/api/token', require('./routes/token-status'));

// Endpoint de version (public pour le status badge) - Déplacé AVANT l'auth globale
app.get('/api/version/check', (req, res) => {
  const versionCheckService = require('./services/VersionCheckService');
  res.json(versionCheckService.getStatus());
});



// Route media en PREMIER sans auth pour les GET
app.use('/api/media', mediaRoutes);

// ============================================
// INTERNAL API - SMS depuis Asterisk (localhost only)
// ============================================
app.post('/api/internal/sms/incoming', async (req, res) => {
  // Vérifier que la requête vient de localhost
  const ip = req.ip || req.connection.remoteAddress;
  if (!ip.includes('127.0.0.1') && !ip.includes('::1') && !ip.includes('localhost')) {
    console.log(`[SMS] Rejected incoming SMS from non-local IP: ${ip}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { from, text, device } = req.body;
  const timestamp = Date.now();
  const messageId = `sms-${timestamp}-${Math.random().toString(36).substring(7)}`;

  console.log(`[SMS] Incoming SMS from ${from} via ${device}: ${text}`);

  try {
    // 1. Import services
    const db = require('./services/DatabaseService');
    const webPushService = require('./services/WebPushService');
    const pushRelayService = require('./services/PushRelayService');

    // 2. Create/update chat in database
    const chatId = `sms-${from.replace(/[^0-9+]/g, '')}`;
    const chatStmt = db.prepare(`
      INSERT INTO chats (id, name, provider, timestamp, local_phone_number)
      VALUES (?, ?, 'sms', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        timestamp = excluded.timestamp,
        unread_count = unread_count + 1
    `);
    chatStmt.run(chatId, from, Math.floor(timestamp / 1000), device);

    // 3. Store message in database
    const msgStmt = db.prepare(`
      INSERT INTO messages (id, chat_id, sender_id, from_me, type, content, timestamp, status)
      VALUES (?, ?, ?, 0, 'text', ?, ?, 'received')
    `);
    msgStmt.run(messageId, chatId, from, text, Math.floor(timestamp / 1000));

    console.log(`[SMS] Stored in DB: messageId=${messageId}, chatId=${chatId}`);

    // 4. Broadcast via WebSocket to all connected clients
    pushService.broadcast('new_message', {
      id: messageId,
      chatId: chatId,
      from: from,
      content: text,
      timestamp: timestamp,
      fromMe: false,
      provider: 'sms',
      type: 'text',
      device: device
    });

    // 5. Send Web Push notifications (PWA offline)
    try {
      await webPushService.notifyNewMessage(from, text, chatId, false);
      console.log(`[SMS] Web push sent for message from ${from}`);
    } catch (pushErr) {
      console.warn(`[SMS] Web push failed:`, pushErr.message);
    }

    // 6. Send Push Relay notifications (iOS/Android apps)
    if (pushRelayService.isConfigured()) {
      try {
        // Get users who should receive notifications for this modem
        const users = db.getUsersForModemSmsNotifications(device);

        if (users.length === 0) {
          // No specific mappings - broadcast to all users
          console.log(`[SMS] No modem mappings found, broadcasting to all users`);
          const result = await pushRelayService.broadcast('new_message', {
            chatId: chatId,
            messageId: messageId,
            senderName: from,
            provider: 'sms',
            modemId: device
          }, {
            title: `SMS: ${from}`,
            body: text.length > 100 ? text.substring(0, 100) + '...' : text
          });
          console.log(`[SMS] Push relay broadcast: sent=${result.sent || 0}`);
        } else {
          // Send to specific users mapped to this modem
          for (const user of users) {
            const result = await pushRelayService.sendNewMessage(user.id, {
              chatId: chatId,
              messageId: messageId,
              senderName: from,
              preview: text.length > 100 ? text.substring(0, 100) + '...' : text
            });
            console.log(`[SMS] Push relay sent to user ${user.id}: sent=${result.sent || 0}`);
          }
        }
      } catch (relayErr) {
        console.warn(`[SMS] Push relay failed:`, relayErr.message);
      }
    }

    // 7. Legacy Socket.IO emit (if available)
    if (global.io) {
      global.io.emit('sms:incoming', {
        id: messageId,
        from,
        text,
        device,
        timestamp: new Date(timestamp).toISOString()
      });
    }

    res.json({
      success: true,
      message: 'SMS received and notifications sent',
      messageId: messageId,
      chatId: chatId
    });

  } catch (error) {
    console.error(`[SMS] Error processing incoming SMS:`, error);
    res.status(500).json({ error: 'Failed to process SMS', details: error.message });
  }
});

// Routes protégées - Ajouter le middleware d'authentification
app.use('/api/evolution', verifyToken, proxyRoutes);
app.use('/api/providers', providersRoutes);
app.use('/api/v2/providers', providersV2Routes); // API v2 multi-provider
app.use('/api/sessions', sessionsRoutes);
app.use('/api/chats', chatsRoutes);
app.use('/api/contacts', require('./routes/contacts')); // Ajout de la route contacts
app.use('/api/notifications', require('./routes/notifications')); // Push notifications
app.use('/api/calls', callHistoryRoutes); // Historique d'appels partagé (local)
app.use('/api/cdr', cdrRoutes); // CDR API - Asterisk/FreePBX MySQL
app.use('/api/config', configRoutes); // Configuration YAML multi-provider

// Routes Admin (protégées par auth + admin only)
app.use('/api/admin', verifyToken, adminOnlyMiddleware(securityService), adminRouter);

// Routes Discovery pour l'app mobile (protégées par auth simple)
// Health check sans auth, autres routes avec auth
app.get('/api/discovery/health', (req, res) => {
  res.json({ status: 'ok', server: 'Homenichat-serv', timestamp: Date.now() });
});
app.use('/api/discovery', verifyToken, discoveryRouter);

// Routes de compatibilité pour les apps mobiles (iOS/Android)
// Ces routes fournissent des alias vers les endpoints v2 avec le format attendu par les apps
app.use('/api', mobileCompatRoutes);

// Endpoint configuration VoIP (protégé par token)
app.get('/api/config/voip', verifyToken, (req, res) => {
  // Utiliser la config du provider
  const config = voipProvider.getSipConfig();
  res.json({
    ...config,
    displayName: req.user?.username || 'User'
  });
});

// Admin: Get VoIP Config
app.get('/api/admin/voip/config', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  res.json(voipProvider.config);
});

// Admin: Update VoIP Config
app.post('/api/admin/voip/config', verifyToken, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });

  try {
    const newConfig = req.body;
    await voipProvider.initialize(newConfig);
    // TODO: Persist to file/DB if needed, currently in-memory/env
    res.json({ success: true, config: voipProvider.config });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update config' });
  }
});

// Admin: Get FreePBX AMI Status
app.get('/api/admin/ami/status', verifyToken, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Unauthorized' });
  res.json(freepbxAmi.getStatus());
});

// Webhook Yeastar
app.post('/webhook/yeastar/call', async (req, res) => {
  try {
    const result = await voipProvider.handleIncomingCallWebhook(req.body);
    if (result) {
      // Send push notification
      const webPushService = require('./services/WebPushService');
      // Broadcast to all users for now (or find specific user if map exists)
      // For beta: broadcast to all
      pushService.broadcast('incoming_call', result);
    }
    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('VoIP Webhook Error:', error);
    res.status(500).json({ error: 'Internal Error' });
  }
});

// Attention: cette ligne applique auth à TOUTES les routes /api/* restantes
app.use('/api', verifyToken, mediaProxyRoutes);

// Endpoint de debug pour voir la structure exacte des webhooks
app.post('/webhook/debug', (req, res) => {
  logger.info('=== WEBHOOK DEBUG ===');
  logger.info('Headers:', req.headers);
  logger.info('Body:', JSON.stringify(req.body, null, 2));
  logger.info('=== FIN DEBUG ===');
  res.status(200).json({ received: true });
});


// Webhook générique pour tous les providers (avec support multi-session)
app.post('/webhook/:provider/:sessionId?', async (req, res) => {
  try {
    const { provider, sessionId } = req.params;

    let normalizedEvent;

    if (sessionId) {
      // Nouveau : webhook spécifique à une session
      normalizedEvent = await sessionManager.handleWebhook(sessionId, req.body);
    } else {
      // Ancien : webhook global (compatibilité)
      normalizedEvent = await providerManager.handleWebhook(provider, req.body);
    }

    logger.info(`Webhook ${provider} reçu - Type: ${normalizedEvent.type}`);

    // Gérer l'événement normalisé
    switch (normalizedEvent.type) {
      case 'message':
        const messageData = normalizedEvent.data;

        // Si c'est Meta provider, stocker le chat localement
        if (provider === 'meta') {
          console.log('Meta message data:', JSON.stringify(messageData, null, 2));
          chatStorage.processIncomingMessage(messageData).then(processedChat => {
            if (processedChat) {
              logger.info('Chat stored successfully:', JSON.stringify(processedChat));
            } else {
              logger.warn('Failed to process Meta message');
            }
          }).catch(err => {
            logger.error('Error processing Meta message:', err);
          });
        }

        // Vérifier si c'est une réaction
        if (messageData.reactions && messageData.reactions.length > 0) {
          logger.info(`🎯 Réaction reçue:`, messageData.reactions);

          // Utiliser PushService pour les réactions
          pushService.broadcast('reaction', messageData);
        } else {
          // Message normal - Utiliser UNIQUEMENT le PushService pour éviter la duplication
          pushService.pushNewMessage(messageData);
          logger.info('Message poussé via PushService');
        }
        break;

      case 'message_update':
        // Utiliser PushService pour les mises à jour de messages
        pushService.broadcast(pushService.eventTypes.MESSAGE_UPDATE, normalizedEvent.data);
        break;

      case 'chat_update':
        // Utiliser PushService pour les mises à jour de chats
        pushService.broadcast(pushService.eventTypes.CHAT_UPDATED, normalizedEvent.data);
        break;

      case 'connection_update':
        logger.info(`État de connexion ${provider}: ${normalizedEvent.data.state || 'unknown'}`);

        // Utiliser PushService pour les mises à jour de connexion
        pushService.pushConnectionUpdate(provider, normalizedEvent.data);
        break;

      case 'message_status':
        // Gérer les statuts de messages (sent, delivered, read, failed)
        const statusData = normalizedEvent.data;
        logger.info(`Statut de message: ${statusData.messageId} - ${statusData.status}`);

        // Utiliser PushService pour les statuts de messages
        pushService.broadcast(pushService.eventTypes.MESSAGE_STATUS, statusData);

        // TODO: Mettre à jour le statut dans la base de données
        break;

      default:
        logger.warn(`Type d'événement webhook non géré: ${normalizedEvent.type}`);
    }

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Erreur webhook:', error);
    res.status(500).json({ error: 'Webhook error' });
  }
});

// Webhook Evolution API pour compatibilité (redirige vers le nouveau format)
app.post('/webhook/evolution', (req, res) => {
  req.params.provider = 'evolution';
  return app._router.handle(req, res);
});

// Webhook Meta - Vérification GET
app.get('/webhook/meta', async (req, res) => {
  try {
    let metaProvider = providerManager.providers.get('meta');

    if (!metaProvider) {
      // Vérifier si le provider est configuré mais pas chargé
      if (providerManager.config.providers.meta && providerManager.config.providers.meta.enabled) {
        try {
          // Charger temporairement le provider pour la validation
          metaProvider = await providerManager.loadSingleProvider('meta');
        } catch (error) {
          logger.error('Failed to load meta provider for webhook validation:', error);
          return res.status(404).send('Meta provider not configured properly');
        }
      } else {
        return res.status(404).send('Meta provider not configured');
      }
    }

    const challenge = metaProvider.verifyWebhook(req.query);
    if (challenge) {
      logger.info('Meta webhook verification successful');
      res.status(200).send(challenge);
    } else {
      logger.warn('Meta webhook verification failed');
      res.status(403).send('Forbidden');
    }
  } catch (error) {
    logger.error('Meta webhook verification error:', error);
    res.status(500).send('Error');
  }
});

// Servir les fichiers statiques en production
if (process.env.NODE_ENV === 'production') {
  // Interface Admin Panel (React)
  app.use('/admin', express.static(path.join(__dirname, 'admin/dist')));
  app.get('/admin/*', (req, res) => {
    res.sendFile(path.join(__dirname, 'admin/dist', 'index.html'));
  });

  // Frontend principal
  app.use(express.static(path.join(__dirname, '../frontend/build')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/build', 'index.html'));
  });
}

// WebSocket pour le temps réel
const clients = new Map();

wss.on('connection', async (ws, req) => {
  const clientId = Date.now().toString();

  // Initialiser le client sans l'ajouter à la liste des clients actifs
  ws.isAuthenticated = false;
  ws.clientId = clientId;

  logger.info(`Client WebSocket connecté (non authentifié): ${clientId}`);

  // Timeout pour l'authentification (30 secondes)
  const authTimeout = setTimeout(() => {
    if (!ws.isAuthenticated) {
      logger.info(`Client WebSocket ${clientId} fermé - pas d'authentification`);
      ws.close(1008, 'Authentication timeout');
    }
  }, 30000);

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case 'auth':
          // Authentifier le client WebSocket
          if (!data.token) {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Token manquant' }));
            return;
          }

          const user = await verifyWebSocketToken(data.token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'auth_error', error: 'Token invalide' }));
            ws.close(1008, 'Invalid token');
            return;
          }

          // Authentification réussie
          clearTimeout(authTimeout);
          ws.isAuthenticated = true;
          ws.userId = user.id;
          ws.user = user;
          ws.subscribedChats = [];
          clients.set(clientId, ws);

          // Enregistrer dans le PushService
          pushService.registerClient(clientId, ws);

          logger.info(`Client WebSocket authentifié: ${clientId} - User: ${user.username}`);
          ws.send(JSON.stringify({ type: 'auth_success', user: { id: user.id, username: user.username, role: user.role } }));
          break;

        case 'subscribe':
          // S'abonner aux mises à jour d'une conversation (authentification requise)
          if (!ws.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'error', error: 'Non authentifié' }));
            return;
          }
          ws.chatId = data.chatId;
          // Ajouter à la liste des chats suivis
          if (!ws.subscribedChats.includes(data.chatId)) {
            ws.subscribedChats.push(data.chatId);
          }
          logger.info(`Client ${clientId} abonné au chat ${data.chatId}`);
          break;

        case 'typing':
          // Transmettre l'indicateur de frappe (authentification requise)
          if (!ws.isAuthenticated) {
            ws.send(JSON.stringify({ type: 'error', error: 'Non authentifié' }));
            return;
          }
          broadcastToChat(data.chatId, {
            type: 'typing',
            userId: ws.userId,
            isTyping: data.isTyping
          });
          break;

        case 'ping':
          // Répondre au ping avec un pong
          ws.send(JSON.stringify({ type: 'pong' }));
          break;
      }
    } catch (error) {
      logger.error('Erreur WebSocket:', error);
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimeout);
    if (ws.isAuthenticated) {
      clients.delete(clientId);
      pushService.unregisterClient(clientId);
      logger.info(`Client WebSocket déconnecté: ${clientId} - User: ${ws.user?.username}`);
    } else {
      logger.info(`Client WebSocket non authentifié déconnecté: ${clientId}`);
    }
  });

  ws.on('error', (error) => {
    logger.error('Erreur WebSocket client:', error);
  });
});

// Fonction pour diffuser un message à tous les clients d'un chat
function broadcastToChat(chatId, message) {
  logger.info(`Broadcasting to chat ${chatId}`, {
    totalClients: clients.size,
    messageType: message.type
  });

  let sentCount = 0;
  clients.forEach((client) => {
    logger.debug(`Checking client: chatId=${client.chatId}, targetChatId=${chatId}, match=${client.chatId === chatId}`);
    if (client.chatId === chatId && client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(JSON.stringify(message));
      sentCount++;
    }
  });

  logger.info(`Broadcast result: sent to ${sentCount} clients`);
}

// Enregistrer la fonction dans le WebSocketManager
webSocketManager.setBroadcastFunction(broadcastToChat);

// Connexion à Evolution API WebSocket - Désactivé temporairement (404)
// TODO: Vérifier l'URL correcte du WebSocket Evolution API
/*
const evolutionWs = new WebSocket(process.env.EVOLUTION_WS_URL || 'ws://localhost:8080/ws');

evolutionWs.on('open', () => {
  logger.info('Connecté au WebSocket Evolution API');
});

evolutionWs.on('message', (data) => {
  try {
    const message = JSON.parse(data);
    
    // Transmettre les messages aux clients concernés
    if (message.event === 'messages.upsert') {
      const chatId = message.data.key.remoteJid;
      broadcastToChat(chatId, {
        type: 'new_message',
        data: message.data
      });
    }
  } catch (error) {
    logger.error('Erreur traitement message Evolution:', error);
  }
});

evolutionWs.on('error', (error) => {
  logger.error('Erreur WebSocket Evolution:', error);
});
*/

// Gestion des erreurs globales
app.use((err, req, res, next) => {
  logger.error(err.stack);
  res.status(500).json({
    error: 'Une erreur est survenue',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Fonction pour broadcaster aux clients WebSocket
function broadcastMessage(message) {
  let clientCount = 0;
  clients.forEach((client, clientId) => {
    if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
      client.send(JSON.stringify(message));
      clientCount++;
    }
  });
  logger.info(`Message diffusé via poller à ${clientCount} clients WebSocket`);
}

// Démarrer le message poller - DÉSACTIVÉ car on utilise les webhooks
// const messagePoller = new MessagePoller(broadcastMessage);
// messagePoller.start();
logger.info('MessagePoller désactivé - utilisation des webhooks uniquement');

const versionCheckService = require('./services/VersionCheckService');

// Initialiser le ProviderManager et SessionManager au démarrage
async function startServer() {
  try {
    // Initialiser la base de données et le service de sécurité
    // DatabaseService est déjà une instance singleton
    const db = require('./services/DatabaseService');

    securityService = new SecurityService(db);
    logger.info('SecurityService initialized successfully');

    // Initialiser les routes admin avec les services
    initAdminRoutes({
      securityService,
      providerManager,
      sessionManager,
      configService: require('./services/ConfigurationService'),
      db,
      port: PORT,
      dataDir: process.env.DATA_DIR || '/var/lib/homenichat',
    });
    logger.info('Admin routes initialized successfully');

    // Initialiser les routes discovery pour l'app mobile
    initDiscoveryRoutes({
      securityService,
      providerManager,
      db,
    });
    logger.info('Discovery routes initialized successfully');

    // Initialiser le gestionnaire de providers
    await providerManager.initialize();
    logger.info('ProviderManager initialized successfully');

    // Initialiser le gestionnaire de sessions
    await sessionManager.initialize();
    logger.info('SessionManager initialized successfully');

    // Initialiser le vérificateur de version
    await versionCheckService.initialize();
    logger.info('VersionCheckService initialized successfully');

    // Initialiser FCM Push Service (optionnel - nécessite firebase-service-account.json)
    const fcmPushService = require('./services/FCMPushService');
    const fcmInitialized = await fcmPushService.initialize();
    if (fcmInitialized) {
      logger.info('FCMPushService initialized successfully');
    } else {
      logger.info('FCMPushService disabled (no service account key)');
    }

    // Configurer les événements du provider
    providerManager.on('providerChanged', (data) => {
      logger.info(`Provider changed from ${data.previous} to ${data.current}`);

      // Notifier tous les clients WebSocket du changement
      const message = {
        type: 'provider_changed',
        data: {
          previous: data.previous,
          current: data.current
        }
      };

      clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.isAuthenticated) {
          client.send(JSON.stringify(message));
        }
      });
    });

    // Écouter les mises à jour de connexion des providers (QR code, status, etc.)
    providerManager.on('connection.update', (data) => {
      // data = { provider: 'baileys', status: 'connecting', qrCode: '...' }
      logger.info(`Connection update from ${data.provider}: ${data.status}`);
      pushService.pushConnectionUpdate(data.provider, data);
    });

    // Écouter les indicateurs de frappe (typing) des providers
    providerManager.on('presence.update', (data) => {
      // data = { provider: 'baileys', chatId, participantJid, isTyping, presence }
      logger.info(`✏️ Presence from ${data.provider}: ${data.participantJid} is ${data.isTyping ? 'typing' : 'idle'} in ${data.chatId}`);
      pushService.pushTypingIndicator(data.chatId, data.participantJid, data.isTyping);
    });

    // Écouter les mises à jour de statut des messages (delivered, read)
    providerManager.on('message.status', (data) => {
      // data = { provider: 'baileys', chatId, messageId, status }
      logger.info(`📬 Message status from ${data.provider}: ${data.messageId} -> ${data.status}`);
      pushService.pushMessageStatus(data.chatId, data.messageId, data.status);
    });

    // Écouter les messages entrants des providers (Baileys, SMS, Meta, etc.)
    providerManager.on('message', async (data) => {
      // data = { provider: 'baileys'|'sms-bridge'|'meta', ...messageData }
      const messageData = data;
      const providerName = messageData.provider || 'unknown';

      logger.info(`📨 Message reçu de ${providerName}: ${messageData.id || 'no-id'}`);

      // Note: Le stockage est géré par chaque provider:
      // - Baileys: stocke dans handleMessagesUpsert
      // - Meta: stocke via webhook dans server.js
      // - SMS Bridge: stocke dans sa propre logique

      // Push via WebSocket à tous les clients
      pushService.pushNewMessage(messageData);
      logger.info(`Message pushé via WebSocket: ${messageData.id || 'no-id'}`);

      // Skip notifications for outgoing messages
      if (messageData.isFromMe || messageData.fromMe) {
        return;
      }

      // Push notification sur les appareils (PWA installée)
      const webPushService = require('./services/WebPushService');
      webPushService.notifyNewMessage(
        messageData.chatName || messageData.from,
        messageData.content || messageData.text,
        messageData.chatId,
        false
      ).catch(err => logger.warn('Web push failed:', err.message));

      // Push Relay pour les apps mobiles (iOS/Android)
      const pushRelayService = require('./services/PushRelayService');
      if (pushRelayService.isConfigured()) {
        try {
          const senderName = messageData.chatName || messageData.from || 'Unknown';
          const preview = (messageData.content || messageData.text || '').substring(0, 100);

          // Broadcast to all registered devices
          const result = await pushRelayService.broadcast('new_message', {
            chatId: messageData.chatId,
            messageId: messageData.id,
            senderName: senderName,
            provider: providerName
          }, {
            title: senderName,
            body: preview.length > 100 ? preview + '...' : preview
          });
          logger.info(`[PushRelay] Broadcast for ${providerName} message: sent=${result.sent || 0}`);
        } catch (relayErr) {
          logger.warn('[PushRelay] Failed for message:', relayErr.message);
        }
      }
    });

    // Initialiser WebPushService pour les notifications push (PWA)
    const webPushService = require('./services/WebPushService');
    webPushService.init();

    // Initialiser VoIPPushService pour les notifications iOS (ADDITIVE - n'affecte pas la PWA)
    const voipPushService = require('./services/VoIPPushService');
    logger.info(`[VoIPPush] Service status: ${voipPushService.isConfigured ? 'CONFIGURED' : 'NOT CONFIGURED (simulation mode)'}`);

    // Initialiser AsteriskCDRService (optionnel - nécessite configuration MySQL)
    if (process.env.ASTERISK_CDR_HOST || process.env.CDR_ENABLED === 'true') {
      const asteriskCDRService = require('./services/AsteriskCDRService');
      try {
        await asteriskCDRService.configure({
          host: process.env.ASTERISK_CDR_HOST,
          port: process.env.ASTERISK_CDR_PORT,
          user: process.env.ASTERISK_CDR_USER,
          password: process.env.ASTERISK_CDR_PASSWORD,
          database: process.env.ASTERISK_CDR_DATABASE
        });
        logger.info('AsteriskCDRService initialized successfully');
      } catch (error) {
        logger.warn(`AsteriskCDRService initialization failed: ${error.message}`);
      }
    } else {
      logger.info('AsteriskCDRService disabled (set ASTERISK_CDR_HOST or CDR_ENABLED=true to enable)');
    }

    // Démarrage du serveur
    server.listen(PORT, () => {
      logger.info(`Serveur L'ekip-Chat démarré sur le port ${PORT}`);
      logger.info(`Active Provider: ${providerManager.activeProvider?.getProviderName() || 'none'}`);

      // Démarrer le job de nettoyage des médias (toutes les 24h)
      mediaCleanupJob.start(24);
      logger.info('Media cleanup job started');

      // Démarrer le nettoyage périodique des sessions expirées (toutes les heures)
      setInterval(() => {
        securityService?.cleanupExpiredSessions();
      }, 60 * 60 * 1000);
      logger.info('Security cleanup job scheduled (hourly)');

      // Démarrer le service AMI FreePBX pour tracker tous les appels
      if (process.env.AMI_HOST || process.env.AMI_ENABLED === 'true') {
        freepbxAmi.start();
        logger.info('FreePBX AMI service started');

        // Écouter les appels entrants pour envoyer des notifications push
        freepbxAmi.on('incomingCall', async (callData) => {
          logger.info(`[Server] 📞 Incoming call event: ${callData.callerNumber} -> ext ${callData.extension}`);
          try {
            // Envoyer notification push (VAPID) pour les clients PWA hors-ligne
            await webPushService.notifyIncomingCall(callData);

            // ADDITIVE: Envoyer VoIP push pour les appareils iOS natifs
            // Ceci n'affecte PAS la PWA - c'est un canal séparé
            voipPushService.sendIncomingCallPush(callData).catch(err => {
              logger.warn('[VoIPPush] Failed to send iOS push:', err.message);
            });

            // ADDITIVE: Envoyer Push Relay pour les apps mobiles (iOS/Android)
            const pushRelayService = require('./services/PushRelayService');
            if (pushRelayService.isConfigured()) {
              try {
                const db = require('./services/DatabaseService');
                const modemId = callData.lineName || callData.channel?.split('/')[1]?.split('-')[0] || 'unknown';

                // Get users who should receive call notifications
                const users = db.getUsersForModemCallNotifications(modemId);

                if (users.length === 0) {
                  // No specific mappings - broadcast to all users
                  const result = await pushRelayService.broadcast('incoming_call', {
                    callId: callData.callId,
                    callerName: callData.callerName || callData.callerNumber,
                    callerNumber: callData.callerNumber,
                    lineName: callData.lineName || modemId,
                    extension: callData.extension
                  });
                  logger.info(`[Server] Push relay broadcast for call: sent=${result.sent || 0}`);
                } else {
                  // Send to specific users mapped to this modem/line
                  for (const user of users) {
                    const result = await pushRelayService.sendIncomingCall(user.id, {
                      callId: callData.callId,
                      callerName: callData.callerName || callData.callerNumber,
                      callerNumber: callData.callerNumber,
                      lineName: callData.lineName || modemId,
                      extension: callData.extension
                    });
                    logger.info(`[Server] Push relay sent to user ${user.id} for call: sent=${result.sent || 0}`);
                  }
                }
              } catch (relayErr) {
                logger.warn('[Server] Push relay failed for call:', relayErr.message);
              }
            }
          } catch (error) {
            logger.error('[Server] Error sending incoming call push:', error);
          }
        });

        // Écouter la fin des appels pour arrêter les sonneries
        freepbxAmi.on('callEnded', async (callData) => {
          logger.info(`[Server] 📞 Call ended event: ${callData.callId} - ${callData.status}`);
          try {
            // Envoyer notification pour remplacer/fermer la notification d'appel
            await webPushService.notifyCallEnded(callData.callId, callData.status);
          } catch (error) {
            logger.error('[Server] Error sending call ended push:', error);
          }
        });

      } else {
        logger.info('FreePBX AMI service disabled (set AMI_HOST or AMI_ENABLED=true to enable)');
      }

      // Démarrer le monitoring des tokens Meta
      if (providerManager.config?.defaultProvider === 'meta') {
        const tokenMonitor = require('./services/TokenMonitor');
        tokenMonitor.start().catch(console.error);
        logger.info('Token monitoring started for Meta provider');
      }
    });
  } catch (error) {
    logger.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Démarrer l'application
startServer();

// =====================================================================
// Graceful Shutdown Handler
// Ensures Baileys worker and other resources are properly cleaned up
// =====================================================================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.warn(`[Shutdown] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;

  logger.info(`[Shutdown] Received ${signal}, initiating graceful shutdown...`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('[Shutdown] HTTP server closed');
  });

  // Shutdown Baileys worker if running
  try {
    const baileysProvider = providerManager.providers?.get('baileys');
    if (baileysProvider && typeof baileysProvider.shutdown === 'function') {
      logger.info('[Shutdown] Shutting down Baileys worker...');
      await baileysProvider.shutdown();
      logger.info('[Shutdown] Baileys worker shut down successfully');
    }
  } catch (error) {
    logger.error('[Shutdown] Error shutting down Baileys:', error.message);
  }

  // Close WebSocket connections
  try {
    const wss = require('./services/WebSocketManager').getWSS?.();
    if (wss) {
      wss.clients.forEach((client) => {
        client.close(1001, 'Server shutting down');
      });
      logger.info('[Shutdown] WebSocket connections closed');
    }
  } catch (error) {
    logger.warn('[Shutdown] Error closing WebSocket connections:', error.message);
  }

  // Give time for cleanup
  setTimeout(() => {
    logger.info('[Shutdown] Exiting process');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Export pour les tests
module.exports = { app, broadcastToChat };