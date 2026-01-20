#!/usr/bin/env node
/**
 * Homenichat First Boot Provisioning
 *
 * Automatic enrollment script for Homenichat Relay (WireGuard + TURN)
 *
 * This script:
 * 1. Checks if WireGuard is already configured
 * 2. Generates WireGuard key pair if needed
 * 3. Registers with the Homenichat Provisioning API
 * 4. Writes the WireGuard configuration
 * 5. Starts the WireGuard service
 *
 * Usage:
 *   node first-boot-provisioning.js
 *
 * Environment variables:
 *   PROVISIONING_URL - URL of the provisioning API (default: https://relay.homenichat.com/api)
 *   LICENSE_KEY - Your Homenichat license key
 *   HOSTNAME - Friendly name for this device (default: system hostname)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execSync, exec } = require('child_process');
const os = require('os');

// Configuration
const CONFIG = {
  provisioningUrl: process.env.PROVISIONING_URL || 'https://relay.homenichat.com',
  licenseKey: process.env.LICENSE_KEY || process.env.HOMENICHAT_LICENSE_KEY,
  hostname: process.env.HOSTNAME || os.hostname(),
  dataDir: process.env.DATA_DIR || '/var/lib/homenichat',
  wgInterface: 'wg-relay',
  wgConfigDir: '/etc/wireguard',
};

// Paths
const PATHS = {
  privateKey: path.join(CONFIG.dataDir, 'wireguard-keys', 'relay_private.key'),
  publicKey: path.join(CONFIG.dataDir, 'wireguard-keys', 'relay_public.key'),
  wgConfig: path.join(CONFIG.wgConfigDir, `${CONFIG.wgInterface}.conf`),
  registration: path.join(CONFIG.dataDir, 'relay-registration.json'),
  turnCredentials: path.join(CONFIG.dataDir, 'turn-credentials.json'),
};

/**
 * Logger with colors
 */
const log = {
  info: (msg) => console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`),
  success: (msg) => console.log(`\x1b[32m[SUCCESS]\x1b[0m ${msg}`),
  warn: (msg) => console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`),
  error: (msg) => console.log(`\x1b[31m[ERROR]\x1b[0m ${msg}`),
};

/**
 * Check if WireGuard tools are installed
 */
function isWireGuardInstalled() {
  try {
    execSync('which wg', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if already provisioned
 */
function isAlreadyProvisioned() {
  return fs.existsSync(PATHS.wgConfig) && fs.existsSync(PATHS.registration);
}

/**
 * Generate WireGuard key pair
 */
function generateKeys() {
  const keysDir = path.dirname(PATHS.privateKey);

  if (!fs.existsSync(keysDir)) {
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 });
  }

  if (!fs.existsSync(PATHS.privateKey)) {
    log.info('Generating WireGuard key pair...');

    const privateKey = execSync('wg genkey').toString().trim();
    const publicKey = execSync(`echo "${privateKey}" | wg pubkey`).toString().trim();

    fs.writeFileSync(PATHS.privateKey, privateKey, { mode: 0o600 });
    fs.writeFileSync(PATHS.publicKey, publicKey, { mode: 0o644 });

    log.success('Keys generated');
  }

  return {
    privateKey: fs.readFileSync(PATHS.privateKey, 'utf8').trim(),
    publicKey: fs.readFileSync(PATHS.publicKey, 'utf8').trim(),
  };
}

/**
 * Make HTTP request
 */
function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, CONFIG.provisioningUrl);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'homenichat-serv/1.0',
      },
      timeout: 30000,
    };

    const req = httpModule.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          }
        } catch {
          reject(new Error(`Invalid JSON response: ${data.substring(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

/**
 * Register with provisioning API
 */
async function register(publicKey) {
  log.info(`Registering with ${CONFIG.provisioningUrl}...`);

  const response = await apiRequest('POST', '/api/register', {
    licenseKey: CONFIG.licenseKey,
    publicKey,
    hostname: CONFIG.hostname,
  });

  if (!response.success) {
    throw new Error(response.error || 'Registration failed');
  }

  return response;
}

/**
 * Write WireGuard configuration
 */
function writeWireGuardConfig(privateKey, config) {
  const wgDir = path.dirname(PATHS.wgConfig);
  if (!fs.existsSync(wgDir)) {
    fs.mkdirSync(wgDir, { recursive: true });
  }

  const wg = config.wireguard;

  const configContent = `# Homenichat Relay - WireGuard Client Configuration
# Client ID: ${config.clientId}
# Generated: ${new Date().toISOString()}
#
# SECURITY NOTE: AllowedIPs is restricted to the server IP only.
# This VPN is for accessing Homenichat services, NOT general internet.

[Interface]
PrivateKey = ${privateKey}
Address = ${wg.clientIP}/32

[Peer]
PublicKey = ${wg.serverPublicKey}
Endpoint = ${wg.serverEndpoint}
AllowedIPs = ${wg.allowedIPs}
PersistentKeepalive = ${wg.persistentKeepalive || 25}
`;

  fs.writeFileSync(PATHS.wgConfig, configContent, { mode: 0o600 });
  log.success(`WireGuard config written to ${PATHS.wgConfig}`);
}

/**
 * Save registration data
 */
function saveRegistration(response) {
  fs.writeFileSync(PATHS.registration, JSON.stringify(response, null, 2));
  log.info(`Registration saved to ${PATHS.registration}`);

  if (response.config.turn) {
    fs.writeFileSync(PATHS.turnCredentials, JSON.stringify(response.config.turn, null, 2));
    log.info(`TURN credentials saved to ${PATHS.turnCredentials}`);
  }
}

/**
 * Start WireGuard service
 */
function startWireGuard() {
  log.info('Starting WireGuard service...');

  try {
    // Stop if already running
    execSync(`wg-quick down ${CONFIG.wgInterface} 2>/dev/null || true`, { stdio: 'pipe' });

    // Start
    execSync(`wg-quick up ${CONFIG.wgInterface}`, { stdio: 'pipe' });

    log.success('WireGuard service started');

    // Show status
    const status = execSync(`wg show ${CONFIG.wgInterface}`).toString();
    console.log('\n--- WireGuard Status ---');
    console.log(status);
  } catch (error) {
    log.error(`Failed to start WireGuard: ${error.message}`);
    throw error;
  }
}

/**
 * Enable WireGuard service on boot
 */
function enableOnBoot() {
  try {
    execSync(`systemctl enable wg-quick@${CONFIG.wgInterface}`, { stdio: 'pipe' });
    log.info('WireGuard enabled to start on boot');
  } catch {
    log.warn('Could not enable WireGuard on boot (systemd may not be available)');
  }
}

/**
 * Create TURN credential refresh script
 */
function createTurnRefreshScript() {
  const scriptPath = '/usr/local/bin/homenichat-refresh-turn';
  const scriptContent = `#!/bin/bash
# Refresh TURN credentials from Homenichat Relay

CONFIG_DIR="${CONFIG.dataDir}"
PROVISIONING_URL="${CONFIG.provisioningUrl}"

if [ ! -f "\$CONFIG_DIR/relay-registration.json" ]; then
    echo "Not registered with relay"
    exit 1
fi

CLIENT_ID=$(jq -r '.clientId // .config.clientId' "\$CONFIG_DIR/relay-registration.json")

if [ -z "\$CLIENT_ID" ]; then
    echo "Could not find client ID"
    exit 1
fi

RESPONSE=$(curl -s -X POST "\$PROVISIONING_URL/api/turn-credentials" \\
    -H "Content-Type: application/json" \\
    -d "{\\"clientId\\": \\"\$CLIENT_ID\\"}")

if echo "\$RESPONSE" | jq -e '.success == true' > /dev/null 2>&1; then
    echo "\$RESPONSE" | jq '.turn' > "\$CONFIG_DIR/turn-credentials.json"
    echo "$(date): TURN credentials refreshed"
else
    echo "$(date): Failed to refresh TURN credentials"
    echo "\$RESPONSE"
fi
`;

  try {
    fs.writeFileSync(scriptPath, scriptContent, { mode: 0o755 });
    log.info(`TURN refresh script created at ${scriptPath}`);

    // Create systemd timer for periodic refresh
    const timerContent = `[Unit]
Description=Refresh Homenichat TURN credentials

[Timer]
OnBootSec=1min
OnUnitActiveSec=12h

[Install]
WantedBy=timers.target
`;

    const serviceContent = `[Unit]
Description=Refresh Homenichat TURN credentials

[Service]
Type=oneshot
ExecStart=${scriptPath}
`;

    fs.writeFileSync('/etc/systemd/system/homenichat-turn-refresh.timer', timerContent);
    fs.writeFileSync('/etc/systemd/system/homenichat-turn-refresh.service', serviceContent);

    execSync('systemctl daemon-reload', { stdio: 'pipe' });
    execSync('systemctl enable homenichat-turn-refresh.timer', { stdio: 'pipe' });
    execSync('systemctl start homenichat-turn-refresh.timer', { stdio: 'pipe' });

    log.success('TURN credential refresh timer enabled');
  } catch (error) {
    log.warn(`Could not create TURN refresh script: ${error.message}`);
  }
}

/**
 * Main function
 */
async function main() {
  console.log('\n=== Homenichat First Boot Provisioning ===\n');

  // Check if WireGuard is installed
  if (!isWireGuardInstalled()) {
    log.error('WireGuard is not installed');
    log.info('Install with: apt install wireguard wireguard-tools');
    process.exit(1);
  }

  // Check license key
  if (!CONFIG.licenseKey) {
    log.error('LICENSE_KEY environment variable is required');
    log.info('Set it with: export LICENSE_KEY=your-license-key');
    process.exit(1);
  }

  // Check if already provisioned
  if (isAlreadyProvisioned()) {
    log.info('Already provisioned. To re-provision, delete:');
    log.info(`  - ${PATHS.wgConfig}`);
    log.info(`  - ${PATHS.registration}`);

    // Try to start if not running
    try {
      execSync(`wg show ${CONFIG.wgInterface}`, { stdio: 'pipe' });
      log.success('WireGuard is already running');
    } catch {
      startWireGuard();
    }

    process.exit(0);
  }

  try {
    // Generate keys
    const keys = generateKeys();
    log.info(`Public Key: ${keys.publicKey}`);

    // Register with provisioning API
    const response = await register(keys.publicKey);

    if (response.existing) {
      log.info('Client already registered, received existing configuration');
    } else {
      log.success('Client registered successfully!');
    }

    log.info(`Client ID: ${response.clientId}`);
    log.info(`Subdomain: ${response.config.subdomain}`);
    log.info(`Public URL: ${response.config.publicUrl}`);
    log.info(`Assigned IP: ${response.config.wireguard.clientIP}`);

    // Write configuration
    writeWireGuardConfig(keys.privateKey, response.config);

    // Save registration
    saveRegistration(response);

    // Start WireGuard
    startWireGuard();

    // Enable on boot
    enableOnBoot();

    // Create TURN refresh script
    createTurnRefreshScript();

    console.log('\n=== Provisioning Complete ===\n');
    console.log(`Your Homenichat server is now accessible at:`);
    console.log(`  ${response.config.publicUrl}`);
    console.log('');
    console.log('Useful commands:');
    console.log(`  wg show ${CONFIG.wgInterface}        # Show tunnel status`);
    console.log(`  cat ${PATHS.turnCredentials}  # Show TURN credentials`);
    console.log(`  homenichat-refresh-turn       # Refresh TURN credentials`);
    console.log('');

  } catch (error) {
    log.error(`Provisioning failed: ${error.message}`);
    process.exit(1);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch((error) => {
    log.error(error.message);
    process.exit(1);
  });
}

module.exports = { main, CONFIG, PATHS };
