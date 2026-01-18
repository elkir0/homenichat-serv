/**
 * PjsipConfigService - Manages PJSIP extensions via config files
 *
 * This service writes PJSIP extension configurations directly to config files.
 * Used for standalone Asterisk installations (without FreePBX).
 *
 * IMPORTANT: AOR section name MUST match the SIP username/extension number!
 * See docs/WEBRTC-VOIP-CONFIG.md for the full explanation.
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const logger = require('../utils/logger');

const PJSIP_DYNAMIC_CONF = '/etc/asterisk/pjsip_extensions_dynamic.conf';
const PJSIP_BACKUP_DIR = '/etc/asterisk/backup';

class PjsipConfigService {
  constructor() {
    this.extensions = new Map();
    this.loaded = false;
  }

  /**
   * Load existing extensions from config file
   */
  async load() {
    try {
      if (!fs.existsSync(PJSIP_DYNAMIC_CONF)) {
        logger.info('[PjsipConfig] No dynamic config file found, starting fresh');
        this.extensions = new Map();
        this.loaded = true;
        return;
      }

      const content = fs.readFileSync(PJSIP_DYNAMIC_CONF, 'utf8');
      this.parseConfig(content);
      this.loaded = true;
      logger.info(`[PjsipConfig] Loaded ${this.extensions.size} extensions from config`);
    } catch (error) {
      logger.error('[PjsipConfig] Error loading config:', error.message);
      this.extensions = new Map();
      this.loaded = true;
    }
  }

  /**
   * Parse PJSIP config content and extract extensions
   */
  parseConfig(content) {
    const lines = content.split('\n');
    let currentSection = null;
    let currentType = null;
    let currentData = {};

    for (const line of lines) {
      const trimmed = line.trim();

      // Skip comments and empty lines
      if (!trimmed || trimmed.startsWith(';')) continue;

      // Section header
      const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
      if (sectionMatch) {
        // Save previous section
        if (currentSection && currentType === 'endpoint') {
          const ext = currentSection.replace('-auth', '');
          if (!this.extensions.has(ext)) {
            this.extensions.set(ext, { extension: ext });
          }
          Object.assign(this.extensions.get(ext), currentData);
        }

        currentSection = sectionMatch[1];
        currentType = null;
        currentData = {};
        continue;
      }

      // Key=value
      const kvMatch = trimmed.match(/^([^=]+)=(.*)$/);
      if (kvMatch) {
        const key = kvMatch[1].trim();
        const value = kvMatch[2].trim();

        if (key === 'type') {
          currentType = value;
        }
        currentData[key] = value;
      }
    }
  }

  /**
   * Create or update a PJSIP extension
   *
   * CRITICAL: The AOR section MUST have the same name as the extension!
   *
   * @param {object} config - Extension configuration
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async createExtension(config) {
    const {
      extension,
      password,
      displayName,
      context = 'from-internal',
      codecs = ['opus', 'ulaw', 'alaw'],
    } = config;

    if (!extension || !password) {
      return { success: false, message: 'Extension and password are required' };
    }

    // Validate extension format
    if (!/^\d{3,5}$/.test(extension)) {
      return { success: false, message: 'Extension must be 3-5 digits' };
    }

    try {
      // Store extension data
      this.extensions.set(extension, {
        extension,
        password,
        displayName: displayName || `Homenichat ${extension}`,
        context,
        codecs: Array.isArray(codecs) ? codecs : codecs.split(','),
        createdAt: Date.now(),
      });

      // Write to config file
      await this.saveConfig();

      // Reload PJSIP
      await this.reloadPjsip();

      logger.info(`[PjsipConfig] Extension ${extension} created/updated`);
      return { success: true, message: `Extension ${extension} configured` };

    } catch (error) {
      logger.error(`[PjsipConfig] Error creating extension ${extension}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Delete a PJSIP extension
   *
   * @param {string} extension - Extension number to delete
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async deleteExtension(extension) {
    if (!this.extensions.has(extension)) {
      return { success: false, message: `Extension ${extension} not found` };
    }

    try {
      this.extensions.delete(extension);
      await this.saveConfig();
      await this.reloadPjsip();

      logger.info(`[PjsipConfig] Extension ${extension} deleted`);
      return { success: true, message: `Extension ${extension} deleted` };

    } catch (error) {
      logger.error(`[PjsipConfig] Error deleting extension ${extension}:`, error.message);
      return { success: false, message: error.message };
    }
  }

  /**
   * Get extension configuration
   *
   * @param {string} extension - Extension number
   * @returns {object|null}
   */
  getExtension(extension) {
    return this.extensions.get(extension) || null;
  }

  /**
   * List all configured extensions
   *
   * @returns {Array}
   */
  listExtensions() {
    return Array.from(this.extensions.values()).map(ext => ({
      extension: ext.extension,
      displayName: ext.displayName,
      context: ext.context,
      createdAt: ext.createdAt,
    }));
  }

  /**
   * Save all extensions to config file
   *
   * CRITICAL: AOR section name MUST match extension number!
   * Wrong: [1001-aor] with aors=1001-aor
   * Correct: [1001] type=aor with aors=1001
   */
  async saveConfig() {
    const lines = [
      '; Homenichat PJSIP Dynamic Extensions',
      '; Auto-generated by PjsipConfigService',
      '; DO NOT EDIT MANUALLY - changes will be overwritten',
      `;`,
      '; IMPORTANT: AOR section name MUST match extension number!',
      '; See docs/WEBRTC-VOIP-CONFIG.md for details.',
      `;`,
      `; Generated: ${new Date().toISOString()}`,
      '',
    ];

    for (const [ext, config] of this.extensions) {
      const codecsStr = config.codecs ? config.codecs.join(',') : 'opus,ulaw,alaw';
      const callerid = config.displayName
        ? `"${config.displayName}" <${ext}>`
        : ext;

      // ENDPOINT section
      lines.push(
        `; === Extension ${ext} ===`,
        `[${ext}]`,
        `type=endpoint`,
        `context=${config.context || 'from-internal'}`,
        `disallow=all`,
        `allow=${codecsStr}`,
        `transport=transport-ws`,
        `webrtc=yes`,
        `auth=${ext}-auth`,
        `aors=${ext}`,  // MUST match AOR section name below!
        `direct_media=no`,
        `dtmf_mode=rfc4733`,
        `identify_by=username`,
        `callerid=${callerid}`,
        '',
      );

      // AUTH section
      lines.push(
        `[${ext}-auth]`,
        `type=auth`,
        `auth_type=userpass`,
        `username=${ext}`,
        `password=${config.password}`,
        '',
      );

      // AOR section - CRITICAL: name must match extension number!
      lines.push(
        `[${ext}]`,  // Same name as endpoint!
        `type=aor`,
        `max_contacts=5`,
        `remove_existing=yes`,
        '',
      );
    }

    // Create backup directory
    if (!fs.existsSync(PJSIP_BACKUP_DIR)) {
      fs.mkdirSync(PJSIP_BACKUP_DIR, { recursive: true });
    }

    // Backup existing config
    if (fs.existsSync(PJSIP_DYNAMIC_CONF)) {
      const backupPath = path.join(
        PJSIP_BACKUP_DIR,
        `pjsip_extensions_dynamic_${Date.now()}.conf`
      );
      fs.copyFileSync(PJSIP_DYNAMIC_CONF, backupPath);
    }

    // Write new config
    fs.writeFileSync(PJSIP_DYNAMIC_CONF, lines.join('\n'), 'utf8');

    // Set permissions
    try {
      fs.chmodSync(PJSIP_DYNAMIC_CONF, 0o644);
      // Try to set ownership to asterisk user
      exec(`chown asterisk:asterisk ${PJSIP_DYNAMIC_CONF}`, () => {});
    } catch (e) {
      // Ignore permission errors
    }

    logger.info(`[PjsipConfig] Config saved with ${this.extensions.size} extensions`);
  }

  /**
   * Reload PJSIP module in Asterisk
   */
  async reloadPjsip() {
    return new Promise((resolve) => {
      exec('asterisk -rx "pjsip reload"', (error, stdout, stderr) => {
        if (error) {
          logger.warn(`[PjsipConfig] PJSIP reload warning: ${error.message}`);
        } else {
          logger.info('[PjsipConfig] PJSIP reloaded');
        }
        resolve({ success: !error });
      });
    });
  }

  /**
   * Check if Asterisk is available and PJSIP is loaded
   */
  async checkAsterisk() {
    return new Promise((resolve) => {
      exec('asterisk -rx "pjsip show endpoints" 2>/dev/null', (error, stdout) => {
        if (error) {
          resolve({ available: false, error: error.message });
        } else {
          const endpointCount = (stdout.match(/Endpoint:/g) || []).length;
          resolve({ available: true, endpoints: endpointCount });
        }
      });
    });
  }

  /**
   * Get extension registration status from Asterisk
   *
   * @param {string} extension - Extension number
   * @returns {Promise<object>}
   */
  async getExtensionStatus(extension) {
    return new Promise((resolve) => {
      exec(`asterisk -rx "pjsip show endpoint ${extension}" 2>/dev/null`, (error, stdout) => {
        if (error || !stdout.includes('Endpoint:')) {
          resolve({
            extension,
            exists: false,
            registered: false
          });
          return;
        }

        const hasContacts = stdout.includes('Contact:') && !stdout.includes('Contact:  <none>');
        const deviceState = stdout.match(/DeviceState\s*:\s*(\S+)/)?.[1] || 'Unknown';

        resolve({
          extension,
          exists: true,
          registered: hasContacts,
          deviceState,
        });
      });
    });
  }
}

// Singleton instance
const pjsipConfigService = new PjsipConfigService();

module.exports = pjsipConfigService;
