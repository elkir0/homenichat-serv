/**
 * FreePBX API Service - Full Integration via PHP Scripts
 *
 * This service integrates with FreePBX's native APIs to create
 * extensions and trunks that are visible in the FreePBX GUI.
 *
 * Implementation uses PHP CLI scripts to avoid escaping issues
 * and ensure correct FreePBX Core API usage.
 *
 * PHP Scripts used:
 * - freepbx-create-extension.php
 * - freepbx-delete-extension.php
 * - freepbx-create-trunk.php
 * - freepbx-delete-trunk.php
 * - freepbx-update-secret.php
 * - freepbx-list-extensions.php
 * - freepbx-list-trunks.php
 * - freepbx-extension-exists.php
 */

const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const logger = require('../utils/logger');

class FreePBXApiService {
  constructor() {
    // Scripts directory - can be overridden via environment
    this.scriptsDir = process.env.FREEPBX_SCRIPTS_DIR ||
                      path.join(__dirname, '../scripts');

    this.initialized = false;
    this._isAvailable = null;
  }

  /**
   * Check if FreePBX is available on this system
   */
  async isAvailable() {
    // Cache the result
    if (this._isAvailable !== null) {
      return this._isAvailable;
    }

    try {
      // Check if fwconsole exists (FreePBX CLI)
      execSync('which fwconsole', { encoding: 'utf8', stdio: 'pipe' });

      // Check if FreePBX config exists
      if (!fs.existsSync('/etc/freepbx.conf')) {
        this._isAvailable = false;
        return false;
      }

      // Check if our PHP scripts exist
      const requiredScript = path.join(this.scriptsDir, 'freepbx-create-extension.php');
      if (!fs.existsSync(requiredScript)) {
        logger.warn('[FreePBX API] PHP scripts not found in ' + this.scriptsDir);
        this._isAvailable = false;
        return false;
      }

      this._isAvailable = true;
      this.initialized = true;
      return true;

    } catch (error) {
      this._isAvailable = false;
      return false;
    }
  }

  /**
   * Execute a PHP script and parse JSON result
   */
  async executePhpScript(scriptName, args = []) {
    const scriptPath = path.join(this.scriptsDir, scriptName);

    if (!fs.existsSync(scriptPath)) {
      throw new Error(`Script not found: ${scriptPath}`);
    }

    // Escape arguments for shell
    const escapedArgs = args.map(arg => {
      // Replace single quotes with escaped version for shell
      const escaped = String(arg).replace(/'/g, "'\\''");
      return `'${escaped}'`;
    }).join(' ');

    const command = `php '${scriptPath}' ${escapedArgs}`;

    try {
      const result = execSync(command, {
        encoding: 'utf8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // Parse JSON response
      const trimmed = result.trim();
      if (!trimmed) {
        return { success: false, error: 'Empty response from PHP script' };
      }

      try {
        return JSON.parse(trimmed);
      } catch (parseError) {
        logger.error(`[FreePBX API] JSON parse error: ${trimmed}`);
        return { success: false, error: 'Invalid JSON response' };
      }

    } catch (error) {
      // Check if it's a PHP error
      const stderr = error.stderr ? error.stderr.toString() : '';
      const stdout = error.stdout ? error.stdout.toString() : '';

      logger.error(`[FreePBX API] Script error: ${scriptName}`, {
        error: error.message,
        stderr,
        stdout
      });

      // Try to parse stdout even on error (script might return JSON error)
      if (stdout) {
        try {
          return JSON.parse(stdout.trim());
        } catch {
          // Ignore parse errors
        }
      }

      return { success: false, error: stderr || error.message };
    }
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
      outboundCid = ''
    } = extensionData;

    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available' };
    }

    logger.info(`[FreePBX API] Creating extension ${extension}...`);

    const result = await this.executePhpScript('freepbx-create-extension.php', [
      extension,
      displayName || `Extension ${extension}`,
      secret,
      outboundCid
    ]);

    if (result.success) {
      await this.applyChanges();
      logger.info(`[FreePBX API] Extension ${extension} created successfully`);
      return {
        success: true,
        message: `Extension ${extension} créée dans FreePBX`,
        extension,
        secret,
        visibleInFreePBX: true
      };
    } else {
      logger.error(`[FreePBX API] Failed to create extension ${extension}: ${result.error}`);
      return {
        success: false,
        message: result.error || 'Unknown error'
      };
    }
  }

  /**
   * Delete an extension from FreePBX
   */
  async deleteExtension(extension) {
    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available' };
    }

    logger.info(`[FreePBX API] Deleting extension ${extension}...`);

    const result = await this.executePhpScript('freepbx-delete-extension.php', [extension]);

    if (result.success) {
      await this.applyChanges();
      logger.info(`[FreePBX API] Extension ${extension} deleted`);
      return { success: true, message: `Extension ${extension} supprimée` };
    } else {
      return { success: false, message: result.error || 'Unknown error' };
    }
  }

  /**
   * Update extension secret/password
   */
  async updateExtensionSecret(extension, newSecret) {
    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available' };
    }

    logger.info(`[FreePBX API] Updating secret for extension ${extension}...`);

    const result = await this.executePhpScript('freepbx-update-secret.php', [
      extension,
      newSecret
    ]);

    if (result.success) {
      await this.applyChanges();
      logger.info(`[FreePBX API] Extension ${extension} secret updated`);
      return { success: true, message: `Mot de passe mis à jour pour ${extension}` };
    } else {
      return { success: false, message: result.error || 'Unknown error' };
    }
  }

  /**
   * Check if extension exists in FreePBX
   */
  async extensionExists(extension) {
    if (!await this.isAvailable()) {
      return false;
    }

    const result = await this.executePhpScript('freepbx-extension-exists.php', [extension]);
    return result.exists === true;
  }

  /**
   * List all extensions from FreePBX
   */
  async listExtensions() {
    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available', extensions: [] };
    }

    const result = await this.executePhpScript('freepbx-list-extensions.php', []);

    if (result.success) {
      return {
        success: true,
        extensions: result.extensions || [],
        count: result.count || 0
      };
    } else {
      return { success: false, message: result.error, extensions: [] };
    }
  }

  // =====================================================
  // TRUNK MANAGEMENT
  // =====================================================

  /**
   * Create a Custom trunk for chan_quectel GSM modem
   * Uses correct 3-argument signature: addTrunk($name, $tech, $settings)
   */
  async createTrunk(trunkData) {
    const {
      modemId,
      modemName,
      phoneNumber = ''
    } = trunkData;

    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available' };
    }

    const trunkName = `GSM-${modemId}`.toUpperCase().replace(/[^A-Z0-9-]/g, '');

    logger.info(`[FreePBX API] Creating trunk ${trunkName}...`);

    const result = await this.executePhpScript('freepbx-create-trunk.php', [
      trunkName,
      modemId,
      phoneNumber
    ]);

    if (result.success) {
      await this.applyChanges();
      logger.info(`[FreePBX API] Trunk ${trunkName} created successfully`);
      return {
        success: true,
        message: `Trunk ${trunkName} créé dans FreePBX`,
        trunkId: result.trunkId,
        trunkName: result.trunkName || trunkName,
        dialString: result.dialString || `Quectel/${modemId}/$OUTNUM$`,
        visibleInFreePBX: true
      };
    } else {
      logger.error(`[FreePBX API] Failed to create trunk ${trunkName}: ${result.error}`);
      return {
        success: false,
        message: result.error || 'Unknown error'
      };
    }
  }

  /**
   * Delete a trunk from FreePBX
   */
  async deleteTrunk(trunkNameOrId) {
    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available' };
    }

    logger.info(`[FreePBX API] Deleting trunk ${trunkNameOrId}...`);

    const result = await this.executePhpScript('freepbx-delete-trunk.php', [trunkNameOrId]);

    if (result.success) {
      await this.applyChanges();
      logger.info(`[FreePBX API] Trunk ${trunkNameOrId} deleted`);
      return { success: true, message: `Trunk ${trunkNameOrId} supprimé` };
    } else {
      return { success: false, message: result.error || 'Unknown error' };
    }
  }

  /**
   * List all trunks from FreePBX
   */
  async listTrunks() {
    if (!await this.isAvailable()) {
      return { success: false, message: 'FreePBX not available', trunks: [] };
    }

    const result = await this.executePhpScript('freepbx-list-trunks.php', []);

    if (result.success) {
      return {
        success: true,
        trunks: result.trunks || [],
        count: result.count || 0
      };
    } else {
      return { success: false, message: result.error, trunks: [] };
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
      exec('fwconsole reload --quiet 2>/dev/null', { timeout: 60000 }, (error) => {
        if (error) {
          logger.warn('[FreePBX API] fwconsole reload warning:', error.message);
        }
        resolve(true);
      });
    });
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      initialized: this.initialized,
      available: this._isAvailable,
      scriptsDir: this.scriptsDir,
      hasFreePBXConf: fs.existsSync('/etc/freepbx.conf')
    };
  }
}

// Export singleton
module.exports = new FreePBXApiService();
