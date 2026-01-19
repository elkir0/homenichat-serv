/**
 * UpnpService - UPnP Port Forwarding Management
 *
 * Manages automatic port forwarding via UPnP for VoIP/WebRTC.
 * Uses the upnp-watchdog.sh script for actual UPnP operations.
 *
 * SECURITY: Disabled by default. User must explicitly enable.
 *
 * Ports managed:
 * - 5160/TCP: SIP (signaling) - using alternative port to avoid ISP box conflicts
 * - 10000-10100/UDP: RTP (media)
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

const WATCHDOG_SCRIPT = '/usr/local/bin/upnp-watchdog.sh';
const CONFIG_FILE = '/etc/homenichat/upnp.conf';
const SYSTEMD_TIMER = 'upnp-watchdog.timer';

class UpnpService {
  constructor() {
    this.available = false;
    this.lastStatus = null;
    this.lastCheck = 0;
    this.cacheTimeout = 10000; // 10 seconds cache
  }

  /**
   * Check if UPnP watchdog script is installed
   */
  isInstalled() {
    try {
      return fs.existsSync(WATCHDOG_SCRIPT);
    } catch (e) {
      return false;
    }
  }

  /**
   * Check if miniupnpc is installed
   */
  isMiniupnpcInstalled() {
    try {
      execSync('which upnpc', { stdio: 'pipe' });
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get UPnP status
   * @param {boolean} forceRefresh - Force refresh even if cached
   * @returns {Promise<object>}
   */
  async getStatus(forceRefresh = false) {
    // Return cached status if recent
    if (!forceRefresh && this.lastStatus && (Date.now() - this.lastCheck) < this.cacheTimeout) {
      return this.lastStatus;
    }

    // Check prerequisites
    if (!this.isInstalled()) {
      return {
        installed: false,
        enabled: false,
        available: false,
        error: 'UPnP watchdog script not installed',
        hint: 'Run the installation script or install manually'
      };
    }

    if (!this.isMiniupnpcInstalled()) {
      return {
        installed: true,
        enabled: false,
        available: false,
        error: 'miniupnpc not installed',
        hint: 'Install with: apt install miniupnpc'
      };
    }

    return new Promise((resolve) => {
      exec(`${WATCHDOG_SCRIPT} status-json`, { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          logger.warn(`[UPnP] Status check failed: ${error.message}`);
          const status = {
            installed: true,
            enabled: false,
            available: false,
            error: 'Failed to get UPnP status',
            details: stderr || error.message
          };
          this.lastStatus = status;
          this.lastCheck = Date.now();
          resolve(status);
          return;
        }

        try {
          const status = JSON.parse(stdout.trim());
          status.installed = true;
          this.lastStatus = status;
          this.lastCheck = Date.now();
          resolve(status);
        } catch (parseError) {
          logger.error(`[UPnP] Failed to parse status: ${parseError.message}`);
          const status = {
            installed: true,
            enabled: false,
            available: false,
            error: 'Failed to parse UPnP status',
            rawOutput: stdout
          };
          this.lastStatus = status;
          this.lastCheck = Date.now();
          resolve(status);
        }
      });
    });
  }

  /**
   * Enable UPnP port forwarding
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async enable() {
    if (!this.isInstalled()) {
      return {
        success: false,
        message: 'UPnP watchdog script not installed'
      };
    }

    if (!this.isMiniupnpcInstalled()) {
      return {
        success: false,
        message: 'miniupnpc not installed. Install with: apt install miniupnpc'
      };
    }

    logger.info('[UPnP] Enabling UPnP port forwarding...');

    return new Promise((resolve) => {
      // First, run the watchdog start command
      exec(`${WATCHDOG_SCRIPT} start`, { timeout: 120000 }, (error, stdout, stderr) => {
        if (error) {
          logger.error(`[UPnP] Failed to enable: ${error.message}`);
          resolve({
            success: false,
            message: `Failed to enable UPnP: ${stderr || error.message}`
          });
          return;
        }

        // Enable the systemd timer
        exec(`systemctl enable --now ${SYSTEMD_TIMER} 2>/dev/null || true`, (timerError) => {
          if (timerError) {
            logger.warn(`[UPnP] Timer activation warning: ${timerError.message}`);
          }

          // Clear cache to get fresh status
          this.lastStatus = null;
          this.lastCheck = 0;

          logger.info('[UPnP] UPnP enabled successfully');
          resolve({
            success: true,
            message: 'UPnP enabled. Port mappings created.'
          });
        });
      });
    });
  }

  /**
   * Disable UPnP port forwarding
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async disable() {
    if (!this.isInstalled()) {
      return {
        success: false,
        message: 'UPnP watchdog script not installed'
      };
    }

    logger.info('[UPnP] Disabling UPnP port forwarding...');

    return new Promise((resolve) => {
      // Disable the systemd timer first
      exec(`systemctl disable --now ${SYSTEMD_TIMER} 2>/dev/null || true`, () => {
        // Then run the watchdog stop command to remove mappings
        exec(`${WATCHDOG_SCRIPT} stop`, { timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            logger.error(`[UPnP] Failed to disable: ${error.message}`);
            resolve({
              success: false,
              message: `Failed to disable UPnP: ${stderr || error.message}`
            });
            return;
          }

          // Clear cache
          this.lastStatus = null;
          this.lastCheck = 0;

          logger.info('[UPnP] UPnP disabled successfully');
          resolve({
            success: true,
            message: 'UPnP disabled. Port mappings removed.'
          });
        });
      });
    });
  }

  /**
   * Refresh port mappings (useful if router rebooted)
   * @returns {Promise<{success: boolean, message: string}>}
   */
  async refresh() {
    if (!this.isInstalled()) {
      return {
        success: false,
        message: 'UPnP watchdog script not installed'
      };
    }

    logger.info('[UPnP] Refreshing port mappings...');

    return new Promise((resolve) => {
      exec(`${WATCHDOG_SCRIPT} check`, { timeout: 120000 }, (error, stdout, stderr) => {
        // Clear cache
        this.lastStatus = null;
        this.lastCheck = 0;

        if (error) {
          logger.warn(`[UPnP] Refresh had issues: ${error.message}`);
          resolve({
            success: false,
            message: `Refresh completed with issues: ${stderr || error.message}`
          });
          return;
        }

        logger.info('[UPnP] Port mappings refreshed');
        resolve({
          success: true,
          message: 'Port mappings refreshed successfully'
        });
      });
    });
  }

  /**
   * Get configuration
   * @returns {object}
   */
  getConfig() {
    const defaultConfig = {
      enabled: false,
      leaseDuration: 3600,
      ports: {
        sip: 5160,  // Alternative port to avoid ISP box conflicts (Livebox, Freebox)
        rtpStart: 10000,
        rtpEnd: 10100
      }
    };

    try {
      if (!fs.existsSync(CONFIG_FILE)) {
        return defaultConfig;
      }

      const content = fs.readFileSync(CONFIG_FILE, 'utf8');
      const config = { ...defaultConfig, ports: { ...defaultConfig.ports } };

      // Parse INI-like config
      const enabledMatch = content.match(/^enabled=(\w+)/m);
      if (enabledMatch) {
        config.enabled = enabledMatch[1] === 'true';
      }

      const leaseMatch = content.match(/^lease_duration=(\d+)/m);
      if (leaseMatch) {
        config.leaseDuration = parseInt(leaseMatch[1], 10);
      }

      // Parse port configuration
      const sipMatch = content.match(/^sip=(\d+)/m);
      if (sipMatch) {
        config.ports.sip = parseInt(sipMatch[1], 10);
      }

      const rtpStartMatch = content.match(/^rtp_start=(\d+)/m);
      if (rtpStartMatch) {
        config.ports.rtpStart = parseInt(rtpStartMatch[1], 10);
      }

      const rtpEndMatch = content.match(/^rtp_end=(\d+)/m);
      if (rtpEndMatch) {
        config.ports.rtpEnd = parseInt(rtpEndMatch[1], 10);
      }

      return config;
    } catch (e) {
      logger.error(`[UPnP] Failed to read config: ${e.message}`);
      return defaultConfig;
    }
  }

  /**
   * Check if UPnP router is available on the network
   * @returns {Promise<boolean>}
   */
  async checkRouterAvailable() {
    if (!this.isMiniupnpcInstalled()) {
      return false;
    }

    return new Promise((resolve) => {
      exec('upnpc -s', { timeout: 10000 }, (error, stdout) => {
        if (error || !stdout.includes('Found valid IGD')) {
          resolve(false);
          return;
        }
        resolve(true);
      });
    });
  }
}

// Singleton instance
const upnpService = new UpnpService();

module.exports = upnpService;
