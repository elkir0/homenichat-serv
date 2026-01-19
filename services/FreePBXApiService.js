/**
 * FreePBX API Service - Full Integration via GraphQL/REST
 *
 * This service integrates with FreePBX's native APIs to create
 * extensions and trunks that are visible in the FreePBX GUI.
 *
 * Authentication methods:
 * 1. OAuth2 (recommended for production)
 * 2. Session-based (for local server without OAuth)
 * 3. Direct PHP execution (fallback for trunks)
 *
 * API Endpoints used:
 * - GraphQL: /admin/api/api/gql (extensions)
 * - REST: /admin/api/rest/core/ (trunks)
 * - PHP CLI: fwconsole (apply changes)
 */

const axios = require('axios');
const { execSync, exec } = require('child_process');
const https = require('https');
const logger = require('../utils/logger');

class FreePBXApiService {
  constructor() {
    this.baseUrl = process.env.FREEPBX_URL || 'https://localhost';
    this.apiEndpoint = `${this.baseUrl}/admin/api/api/gql`;
    this.restEndpoint = `${this.baseUrl}/admin/api/rest`;

    this.token = null;
    this.tokenExpiry = null;
    this.sessionCookie = null;

    // Allow self-signed certificates (common for FreePBX)
    this.httpsAgent = new https.Agent({ rejectUnauthorized: false });

    // Credentials
    this.clientId = process.env.FREEPBX_CLIENT_ID || null;
    this.clientSecret = process.env.FREEPBX_CLIENT_SECRET || null;
    this.adminUser = process.env.FREEPBX_ADMIN_USER || 'admin';
    this.adminPass = process.env.FREEPBX_ADMIN_PASS || '';

    this.initialized = false;
    this.authMethod = null; // 'oauth', 'session', 'php'
  }

  /**
   * Initialize and test the connection
   */
  async initialize() {
    if (this.initialized) return true;

    logger.info('[FreePBX API] Initializing connection...');

    // Try OAuth2 first
    if (this.clientId && this.clientSecret) {
      try {
        await this.authenticateOAuth();
        this.authMethod = 'oauth';
        this.initialized = true;
        logger.info('[FreePBX API] Connected via OAuth2');
        return true;
      } catch (error) {
        logger.warn('[FreePBX API] OAuth2 failed, trying session auth...', error.message);
      }
    }

    // Try session-based authentication
    if (this.adminUser && this.adminPass) {
      try {
        await this.authenticateSession();
        this.authMethod = 'session';
        this.initialized = true;
        logger.info('[FreePBX API] Connected via session');
        return true;
      } catch (error) {
        logger.warn('[FreePBX API] Session auth failed, using PHP fallback...', error.message);
      }
    }

    // Fallback to PHP CLI (works if running on same server)
    try {
      await this.testPhpAccess();
      this.authMethod = 'php';
      this.initialized = true;
      logger.info('[FreePBX API] Using PHP CLI fallback');
      return true;
    } catch (error) {
      logger.error('[FreePBX API] All authentication methods failed');
      return false;
    }
  }

  /**
   * OAuth2 Authentication
   */
  async authenticateOAuth() {
    const response = await axios.post(
      `${this.baseUrl}/admin/api/api/token`,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      }),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        httpsAgent: this.httpsAgent
      }
    );

    this.token = response.data.access_token;
    this.tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000; // 1 min buffer
    return true;
  }

  /**
   * Session-based Authentication (login via form)
   */
  async authenticateSession() {
    // First, get the login page to get CSRF token
    const loginPageResponse = await axios.get(
      `${this.baseUrl}/admin/config.php`,
      { httpsAgent: this.httpsAgent, maxRedirects: 0, validateStatus: () => true }
    );

    // Extract session cookie
    const cookies = loginPageResponse.headers['set-cookie'];
    if (!cookies) throw new Error('No session cookie received');

    const sessionId = cookies.find(c => c.includes('PHPSESSID'));
    if (!sessionId) throw new Error('No PHPSESSID found');

    this.sessionCookie = sessionId.split(';')[0];

    // Now login
    const loginResponse = await axios.post(
      `${this.baseUrl}/admin/config.php`,
      new URLSearchParams({
        username: this.adminUser,
        password: this.adminPass,
        submit: 'Login'
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cookie': this.sessionCookie
        },
        httpsAgent: this.httpsAgent,
        maxRedirects: 0,
        validateStatus: () => true
      }
    );

    // Check if login successful (should redirect or return 200)
    if (loginResponse.status === 302 || loginResponse.status === 200) {
      // Update session cookie if new one provided
      const newCookies = loginResponse.headers['set-cookie'];
      if (newCookies) {
        const newSessionId = newCookies.find(c => c.includes('PHPSESSID'));
        if (newSessionId) {
          this.sessionCookie = newSessionId.split(';')[0];
        }
      }
      return true;
    }

    throw new Error('Login failed');
  }

  /**
   * Test PHP CLI access to FreePBX
   */
  async testPhpAccess() {
    return new Promise((resolve, reject) => {
      exec('php -r "require_once \'/etc/freepbx.conf\'; echo \'OK\';"', (error, stdout) => {
        if (error || !stdout.includes('OK')) {
          reject(new Error('PHP FreePBX access not available'));
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Get authorization headers
   */
  getAuthHeaders() {
    if (this.authMethod === 'oauth') {
      return { 'Authorization': `Bearer ${this.token}` };
    } else if (this.authMethod === 'session') {
      return { 'Cookie': this.sessionCookie };
    }
    return {};
  }

  /**
   * Execute GraphQL query/mutation
   */
  async graphqlRequest(query, variables = {}) {
    if (!this.initialized) await this.initialize();

    // Refresh OAuth token if expired
    if (this.authMethod === 'oauth' && Date.now() > this.tokenExpiry) {
      await this.authenticateOAuth();
    }

    const response = await axios.post(
      this.apiEndpoint,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          ...this.getAuthHeaders()
        },
        httpsAgent: this.httpsAgent
      }
    );

    if (response.data.errors) {
      throw new Error(response.data.errors[0].message);
    }

    return response.data;
  }

  // =====================================================
  // EXTENSION MANAGEMENT
  // =====================================================

  /**
   * Create a PJSIP extension in FreePBX
   * This makes the extension visible in FreePBX GUI
   *
   * @param {object} extensionData - Extension configuration
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async createExtension(extensionData) {
    const {
      extension,
      secret,
      displayName,
      webrtc = true,
      email = null,
      voicemail = false,
      vmPassword = null
    } = extensionData;

    if (!this.initialized) await this.initialize();

    // Use GraphQL if available
    if (this.authMethod === 'oauth' || this.authMethod === 'session') {
      return await this.createExtensionViaGraphQL(extensionData);
    }

    // Fallback to PHP CLI
    return await this.createExtensionViaPHP(extensionData);
  }

  /**
   * Create extension via GraphQL API
   */
  async createExtensionViaGraphQL(extensionData) {
    const {
      extension,
      secret,
      displayName,
      webrtc = true,
      context = 'from-internal',
      email = null,
      voicemail = false,
      vmPassword = null
    } = extensionData;

    const mutation = `
      mutation AddExtension($input: AddExtensionInput!) {
        addExtension(input: $input) {
          status
          message
          id
        }
      }
    `;

    const variables = {
      input: {
        extensionId: extension.toString(),
        tech: 'pjsip',
        name: displayName || `Extension ${extension}`,
        sipSecret: secret,
        webRtcEnabled: webrtc,
        transport: webrtc ? 'wss' : 'udp',
        context: context,
        dtlsEnable: webrtc,
        iceSupport: webrtc,
        directMedia: false,
        allowedCodecs: ['g722', 'ulaw', 'alaw', 'opus'],
        clientMutationId: `homenichat-${extension}-${Date.now()}`
      }
    };

    // Add voicemail if requested
    if (voicemail) {
      variables.input.vmEnabled = true;
      variables.input.vmPassword = vmPassword || extension.toString();
      if (email) {
        variables.input.vmEmail = email;
      }
    }

    try {
      const response = await this.graphqlRequest(mutation, variables);
      const result = response.data?.addExtension;

      if (result?.status === 'success' || result?.status === true || result?.id) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Extension ${extension} created via GraphQL`);
        return {
          success: true,
          message: result.message || `Extension ${extension} créée`,
          extension,
          secret,
          visibleInFreePBX: true
        };
      } else {
        return {
          success: false,
          message: result?.message || 'Erreur inconnue lors de la création'
        };
      }
    } catch (error) {
      logger.error(`[FreePBX API] GraphQL createExtension error:`, error.message);

      // Fallback to PHP if GraphQL fails
      if (this.authMethod !== 'php') {
        logger.info('[FreePBX API] Falling back to PHP method...');
        return await this.createExtensionViaPHP(extensionData);
      }

      return { success: false, message: error.message };
    }
  }

  /**
   * Create extension via PHP CLI (fallback)
   */
  async createExtensionViaPHP(extensionData) {
    const {
      extension,
      secret,
      displayName,
      webrtc = true,
      context = 'from-internal',
      voicemail = false,
      vmPassword = null
    } = extensionData;

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

// Check if extension exists
$existing = $freepbx->Core->getUser('${extension}');
if ($existing) {
    echo json_encode(['success' => false, 'message' => 'Extension existe déjà']);
    exit;
}

// Create PJSIP extension
$data = [
    'extension' => '${extension}',
    'name' => '${(displayName || `Extension ${extension}`).replace(/'/g, "\\'")}',
    'tech' => 'pjsip',
    'sipSecret' => '${secret}',
    'context' => '${context}',
    'webrtc' => ${webrtc ? 'true' : 'false'},
    'dtls_enable' => ${webrtc ? 'true' : 'false'},
    'ice_support' => ${webrtc ? 'true' : 'false'},
    'transport' => '${webrtc ? 'wss' : 'udp'}',
    'force_rport' => true,
    'rewrite_contact' => true,
    'direct_media' => false,
    'allow' => 'g722,ulaw,alaw,opus',
    'disallow' => 'all'
];

try {
    $result = $freepbx->Core->addUser($data);

    if (${voicemail ? 'true' : 'false'}) {
        $vmData = [
            'extension' => '${extension}',
            'password' => '${vmPassword || extension}',
            'email' => '',
            'name' => '${(displayName || `Extension ${extension}`).replace(/'/g, "\\'")}'
        ];
        $freepbx->Voicemail->addVoicemail($vmData);
    }

    echo json_encode(['success' => true, 'message' => 'Extension créée', 'id' => $result]);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      const parsed = JSON.parse(result.trim());

      if (parsed.success) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Extension ${extension} created via PHP`);
        return {
          success: true,
          message: parsed.message,
          extension,
          secret,
          visibleInFreePBX: true
        };
      }

      return parsed;

    } catch (error) {
      logger.error(`[FreePBX API] PHP createExtension error:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete an extension from FreePBX
   */
  async deleteExtension(extension) {
    if (!this.initialized) await this.initialize();

    // Try GraphQL first
    if (this.authMethod === 'oauth' || this.authMethod === 'session') {
      try {
        const mutation = `
          mutation DeleteExtension($input: DeleteExtensionInput!) {
            deleteExtension(input: $input) {
              status
              message
            }
          }
        `;

        const variables = {
          input: {
            extensionId: extension.toString(),
            clientMutationId: `homenichat-delete-${extension}-${Date.now()}`
          }
        };

        const response = await this.graphqlRequest(mutation, variables);
        const result = response.data?.deleteExtension;

        if (result?.status === 'success' || result?.status === true) {
          await this.applyChanges();
          logger.info(`[FreePBX API] Extension ${extension} deleted via GraphQL`);
          return { success: true, message: result.message };
        }
      } catch (error) {
        logger.warn(`[FreePBX API] GraphQL deleteExtension error:`, error.message);
      }
    }

    // Fallback to PHP
    return await this.deleteExtensionViaPHP(extension);
  }

  /**
   * Delete extension via PHP CLI
   */
  async deleteExtensionViaPHP(extension) {
    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    $freepbx->Core->delUser('${extension}');
    echo json_encode(['success' => true, 'message' => 'Extension supprimée']);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      const parsed = JSON.parse(result.trim());

      if (parsed.success) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Extension ${extension} deleted via PHP`);
      }

      return parsed;

    } catch (error) {
      logger.error(`[FreePBX API] PHP deleteExtension error:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Update extension secret/password
   */
  async updateExtensionSecret(extension, newSecret) {
    if (!this.initialized) await this.initialize();

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    $user = $freepbx->Core->getUser('${extension}');
    if (!$user) {
        echo json_encode(['success' => false, 'message' => 'Extension non trouvée']);
        exit;
    }

    $user['sipSecret'] = '${newSecret}';
    $freepbx->Core->editUser($user['extension'], $user);
    echo json_encode(['success' => true, 'message' => 'Mot de passe mis à jour']);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      const parsed = JSON.parse(result.trim());

      if (parsed.success) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Extension ${extension} password updated`);
      }

      return parsed;

    } catch (error) {
      logger.error(`[FreePBX API] updateExtensionSecret error:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * List all extensions from FreePBX
   */
  async listExtensions() {
    if (!this.initialized) await this.initialize();

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    $users = $freepbx->Core->getAllUsers();
    $extensions = [];
    foreach ($users as $user) {
        $extensions[] = [
            'extension' => $user['extension'],
            'name' => $user['name'],
            'tech' => $user['tech'] ?? 'pjsip',
            'context' => $user['context'] ?? 'from-internal'
        ];
    }
    echo json_encode(['success' => true, 'extensions' => $extensions]);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      return JSON.parse(result.trim());

    } catch (error) {
      logger.error(`[FreePBX API] listExtensions error:`, error.message);
      return { success: false, message: error.message, extensions: [] };
    }
  }

  /**
   * Check if extension exists in FreePBX
   */
  async extensionExists(extension) {
    if (!this.initialized) await this.initialize();

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();
$user = $freepbx->Core->getUser('${extension}');
echo json_encode(['exists' => $user !== false && $user !== null]);
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 10000
      });

      const parsed = JSON.parse(result.trim());
      return parsed.exists;

    } catch (error) {
      return false;
    }
  }

  // =====================================================
  // TRUNK MANAGEMENT
  // =====================================================

  /**
   * Create a Custom trunk for chan_quectel GSM modem
   * Note: GraphQL doesn't fully support custom trunks, using PHP
   */
  async createTrunk(trunkData) {
    const {
      modemId,
      modemName,
      phoneNumber,
      context = 'from-gsm'
    } = trunkData;

    if (!this.initialized) await this.initialize();

    const trunkName = `GSM-${modemId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    const dialString = `Quectel/${modemId}/$OUTNUM$`;

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    // Check if trunk exists
    $trunks = $freepbx->Core->getTrunks();
    foreach ($trunks as $trunk) {
        if ($trunk['name'] === '${trunkName}') {
            echo json_encode(['success' => false, 'message' => 'Trunk existe déjà']);
            exit;
        }
    }

    // Create custom trunk
    $trunkData = [
        'tech' => 'custom',
        'name' => '${trunkName}',
        'outcid' => '${phoneNumber || ''}',
        'maxchans' => '1',
        'keepcid' => 'on',
        'disabled' => 'off',
        'channelid' => '${modemId}',
        'dialoutprefix' => '',
        'custom_dial' => '${dialString}',
        'description' => 'Modem GSM ${(modemName || modemId).replace(/'/g, "\\'")}'
    ];

    $trunkId = $freepbx->Core->addTrunk($trunkData);

    if ($trunkId) {
        echo json_encode([
            'success' => true,
            'message' => 'Trunk créé',
            'trunkId' => $trunkId,
            'trunkName' => '${trunkName}'
        ]);
    } else {
        echo json_encode(['success' => false, 'message' => 'Erreur lors de la création']);
    }
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      const parsed = JSON.parse(result.trim());

      if (parsed.success) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Trunk ${trunkName} created`);
        return {
          success: true,
          message: parsed.message,
          trunkId: parsed.trunkId,
          trunkName,
          dialString,
          visibleInFreePBX: true
        };
      }

      return parsed;

    } catch (error) {
      logger.error(`[FreePBX API] createTrunk error:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete a trunk from FreePBX
   */
  async deleteTrunk(trunkNameOrId) {
    if (!this.initialized) await this.initialize();

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    $trunks = $freepbx->Core->getTrunks();
    $trunkId = null;

    foreach ($trunks as $trunk) {
        if ($trunk['name'] === '${trunkNameOrId}' || $trunk['trunkid'] == '${trunkNameOrId}') {
            $trunkId = $trunk['trunkid'];
            break;
        }
    }

    if (!$trunkId) {
        echo json_encode(['success' => false, 'message' => 'Trunk non trouvé']);
        exit;
    }

    $freepbx->Core->deleteTrunk($trunkId);
    echo json_encode(['success' => true, 'message' => 'Trunk supprimé']);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      const parsed = JSON.parse(result.trim());

      if (parsed.success) {
        await this.applyChanges();
        logger.info(`[FreePBX API] Trunk ${trunkNameOrId} deleted`);
      }

      return parsed;

    } catch (error) {
      logger.error(`[FreePBX API] deleteTrunk error:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * List all trunks from FreePBX
   */
  async listTrunks() {
    if (!this.initialized) await this.initialize();

    const phpScript = `
<?php
require_once '/etc/freepbx.conf';
$freepbx = \\FreePBX::Create();

try {
    $trunks = $freepbx->Core->getTrunks();
    $result = [];
    foreach ($trunks as $trunk) {
        $result[] = [
            'id' => $trunk['trunkid'],
            'name' => $trunk['name'],
            'tech' => $trunk['tech'],
            'outcid' => $trunk['outcid'] ?? '',
            'disabled' => $trunk['disabled'] ?? 'off'
        ];
    }
    echo json_encode(['success' => true, 'trunks' => $result]);
} catch (Exception $e) {
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
`;

    try {
      const result = execSync(`php -r '${phpScript.replace(/'/g, "'\\''")}'`, {
        encoding: 'utf8',
        timeout: 30000
      });

      return JSON.parse(result.trim());

    } catch (error) {
      logger.error(`[FreePBX API] listTrunks error:`, error.message);
      return { success: false, message: error.message, trunks: [] };
    }
  }

  // =====================================================
  // UTILITIES
  // =====================================================

  /**
   * Apply FreePBX changes (fwconsole reload)
   */
  async applyChanges() {
    return new Promise((resolve) => {
      exec('fwconsole reload --quiet 2>/dev/null || true', { timeout: 60000 }, (error) => {
        if (error) {
          logger.warn('[FreePBX API] fwconsole reload warning:', error.message);
        }
        resolve(true);
      });
    });
  }

  /**
   * Check if FreePBX is available
   */
  async isAvailable() {
    try {
      // Check if fwconsole exists
      execSync('which fwconsole', { encoding: 'utf8' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      authMethod: this.authMethod,
      baseUrl: this.baseUrl,
      hasOAuthCredentials: !!(this.clientId && this.clientSecret),
      hasAdminCredentials: !!(this.adminUser && this.adminPass)
    };
  }
}

// Export singleton
module.exports = new FreePBXApiService();
