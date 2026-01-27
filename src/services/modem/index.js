/**
 * Modem Service
 * Manages GSM modems via Asterisk chan_quectel
 *
 * Supports:
 * - EC25 (Quectel) - 8kHz audio
 * - SIM7600 (Simcom) - 16kHz audio
 *
 * Refactored into modular architecture from monolithic ModemService.js
 */

const logger = require('../../../utils/logger');
const { MODEM_PROFILES, MAX_MODEMS, MAX_PIN_ATTEMPTS } = require('./constants');

// Import modules
const config = require('./config');
const detection = require('./detection');
const asterisk = require('./asterisk');
const sms = require('./sms');
const sim = require('./sim');
const status = require('./status');
const audio = require('./audio');
const volte = require('./volte');
const watchdog = require('./watchdog');

/**
 * ModemService class
 * Provides a unified interface to all modem functionality
 */
class ModemService {
    constructor(options = {}) {
        this.logger = options.logger || logger;

        // Load configuration
        this.modemsConfig = config.loadConfig();

        // Backward compatibility
        this.modemConfig = config.getModemConfig(this.modemsConfig, 'modem-1');

        this.logger.info(`[ModemService] Initialized with ${Object.keys(this.modemsConfig.modems || {}).length} configured modem(s)`);
    }

    // =====================================================
    // Configuration Methods
    // =====================================================

    /**
     * Get configuration for a specific modem
     */
    getModemConfig(modemId = 'modem-1') {
        return config.getModemConfig(this.modemsConfig, modemId);
    }

    /**
     * Get all modems configuration
     */
    getAllModemsConfig() {
        return config.getAllModemsConfig(this.modemsConfig);
    }

    /**
     * Save configuration for a specific modem
     */
    saveModemConfig(modemIdOrConfig, modemConfig = null) {
        // Handle backward compatibility
        let modemId, cfg;
        if (modemConfig === null && typeof modemIdOrConfig === 'object') {
            modemId = 'modem-1';
            cfg = modemIdOrConfig;
        } else {
            modemId = modemIdOrConfig;
            cfg = modemConfig;
        }

        const result = config.saveModemConfig(this.modemsConfig, modemId, cfg);
        this.modemsConfig = config.loadConfig(); // Reload
        return result;
    }

    /**
     * Delete a modem configuration
     */
    deleteModemConfig(modemId) {
        const result = config.deleteModemConfig(this.modemsConfig, modemId);
        this.modemsConfig = config.loadConfig(); // Reload
        return result;
    }

    /**
     * Get modem profiles (EC25, SIM7600)
     */
    getModemProfiles() {
        return MODEM_PROFILES;
    }

    // =====================================================
    // Detection Methods
    // =====================================================

    /**
     * Detect modem type from USB devices
     */
    detectModemTypeFromUsb() {
        return detection.detectModemType();
    }

    /**
     * Detect USB ports and modems
     */
    async detectUsbPorts() {
        return detection.detectUsbPorts();
    }

    /**
     * Collect USB device information
     */
    async collectUsb() {
        return detection.collectUsbInfo();
    }

    /**
     * Calculate audio port from data port
     */
    calculateAudioPort(dataPort, modemType) {
        return detection.calculateAudioPort(dataPort, modemType);
    }

    // =====================================================
    // Asterisk Methods
    // =====================================================

    /**
     * List modems registered in Asterisk
     */
    async listModems() {
        return asterisk.listModems();
    }

    /**
     * Generate quectel.conf content
     */
    generateQuectelConf(cfg = {}) {
        return asterisk.generateQuectelConf(cfg, this.modemsConfig.modems);
    }

    /**
     * Apply quectel.conf configuration
     */
    async applyQuectelConf(cfg = {}) {
        const result = await asterisk.applyQuectelConf(cfg, this.modemsConfig.modems);
        return result;
    }

    /**
     * Read current quectel.conf
     */
    readQuectelConf() {
        return asterisk.readQuectelConf();
    }

    /**
     * Load or reload chan_quectel module
     */
    async loadOrReloadChanQuectel() {
        return asterisk.loadOrReloadChanQuectel();
    }

    /**
     * Restart Asterisk
     */
    async restartAsterisk() {
        return asterisk.restartAsterisk();
    }

    /**
     * Restart a modem
     */
    async restartModem(modemId) {
        return asterisk.restartModem(modemId);
    }

    /**
     * Send AT command via Asterisk
     */
    async sendAtCommand(modemId, command) {
        const { sendAtCommand } = require('./utils');
        return sendAtCommand(modemId, command);
    }

    // =====================================================
    // SMS Methods
    // =====================================================

    /**
     * Send SMS
     */
    async sendSms(modemId, to, message) {
        const modemCfg = this.getModemConfig(modemId);
        return sms.sendSms(modemId, to, message, modemCfg.dataPort);
    }

    // =====================================================
    // SIM Card Methods
    // =====================================================

    /**
     * Check SIM PIN status
     */
    async checkSimPin(modemId) {
        const modemCfg = this.getModemConfig(modemId || 'modem-1');
        return sim.checkSimPin(modemId, modemCfg.dataPort);
    }

    /**
     * Enter SIM PIN
     */
    async enterSimPin(pin, modemId = 'modem-1') {
        const modemCfg = this.getModemConfig(modemId);
        const result = await sim.enterSimPin(
            pin,
            modemId,
            modemCfg.dataPort,
            async () => {
                await this.loadOrReloadChanQuectel();
            }
        );

        // Save PIN to config if successful
        if (result.success && result.pinSaved) {
            this.saveModemConfig(modemId, { pinCode: pin });
        }

        return result;
    }

    /**
     * Get PIN attempts remaining
     */
    getPinAttemptsRemaining(modemId = 'modem-1') {
        return sim.getPinAttemptsRemaining(modemId);
    }

    /**
     * Reset PIN attempts counter
     */
    resetPinAttempts(modemId = null) {
        return sim.resetPinAttempts(modemId);
    }

    /**
     * Get IMSI from modem
     */
    async getModemImsi(dataPort = null) {
        const modemCfg = this.getModemConfig('modem-1');
        return sim.getModemImsi(modemCfg.modemName, dataPort || modemCfg.dataPort);
    }

    // =====================================================
    // Status Methods
    // =====================================================

    /**
     * Collect status for a modem
     */
    async collectModemStatus(modemId) {
        const modemCfg = this.getModemConfig(modemId);
        return status.collectModemStatus(modemId, modemCfg);
    }

    /**
     * Collect statistics for a modem
     */
    async collectModemStats(modemId) {
        return status.collectModemStats(modemId);
    }

    /**
     * Collect service status
     */
    async collectServices() {
        return status.collectServices();
    }

    /**
     * Collect system information
     */
    collectSystem() {
        return status.collectSystem();
    }

    /**
     * Collect all status information
     */
    async collectAll() {
        return status.collectAll(this.modemsConfig.modems);
    }

    // =====================================================
    // Audio Methods
    // =====================================================

    /**
     * Configure audio for modem
     */
    async configureAudio(modemId) {
        return audio.configureAudio(modemId);
    }

    /**
     * Configure audio for specific modem type
     */
    async configureAudioForType(modemId, modemType = null) {
        const type = modemType || this.getModemConfig(modemId).modemType || 'sim7600';
        return audio.configureAudioForType(modemId, type);
    }

    // =====================================================
    // VoLTE Methods (EC25 Modems)
    // =====================================================

    /**
     * Get VoLTE status for a modem
     */
    async getVoLTEStatus(modemId) {
        return volte.getVoLTEStatus(modemId);
    }

    /**
     * Enable VoLTE mode on a modem
     */
    async enableVoLTE(modemId) {
        return volte.enableVoLTE(modemId);
    }

    /**
     * Disable VoLTE mode and return to 3G mode
     */
    async disableVoLTE(modemId) {
        return volte.disableVoLTE(modemId);
    }

    /**
     * Toggle VoLTE mode for a modem
     */
    async toggleVoLTE(modemId, enable) {
        return volte.toggleVoLTE(modemId, enable);
    }

    /**
     * Initialize VoLTE after Asterisk restart
     * Must be called after modem is detected and ready
     */
    async initializeVoLTE(modemId, volteEnabled = false) {
        return volte.initializeVoLTE(modemId, volteEnabled);
    }

    /**
     * Check if USB Audio Class (UAC) device is available
     */
    async isUACDeviceAvailable() {
        return volte.isUACDeviceAvailable();
    }

    /**
     * Get recommended VoLTE configuration for quectel.conf
     */
    getVoLTEQuectelConfig(modemConfig) {
        return volte.getVoLTEQuectelConfig(modemConfig);
    }

    // =====================================================
    // Watchdog Methods
    // =====================================================

    /**
     * Get watchdog instance
     */
    getWatchdog() {
        return watchdog.getWatchdog();
    }

    /**
     * Start watchdog service
     */
    startWatchdog(config = {}) {
        return watchdog.startWatchdog(config);
    }

    /**
     * Stop watchdog service
     */
    stopWatchdog() {
        return watchdog.stopWatchdog();
    }

    /**
     * Get watchdog status
     */
    getWatchdogStatus() {
        return watchdog.getWatchdog().getStatus();
    }

    // =====================================================
    // Service Management Methods
    // =====================================================

    /**
     * Restart all services
     */
    async restartAllServices() {
        const { runCommand } = require('./utils');
        await runCommand('systemctl restart asterisk');
        await runCommand('systemctl restart homenichat');
        return { success: true };
    }

    /**
     * Initialize modem (auto-detect and configure)
     */
    async initializeModem(modemId = null) {
        // Auto-detect modems if not specified
        if (!modemId) {
            const detected = await this.detectUsbPorts();
            if (detected.modems && detected.modems.length > 0) {
                // Apply configuration for all detected modems
                return this.applyQuectelConf({ modems: detected.modems });
            }
            return { success: false, error: 'No modems detected' };
        }

        // Initialize specific modem
        const modemCfg = this.getModemConfig(modemId);

        // Check PIN
        const pinStatus = await this.checkSimPin(modemId);
        if (pinStatus.needsPin && modemCfg.pinCode) {
            await this.enterSimPin(modemCfg.pinCode, modemId);
        }

        // Configure audio
        await this.configureAudioForType(modemId, modemCfg.modemType);

        return { success: true, modemId };
    }

    /**
     * Auto-generate quectel.conf from detected modems
     */
    async autoGenerateQuectelConf(forceRegenerate = false) {
        // Check if config already exists
        const existing = this.readQuectelConf();
        if (existing && !forceRegenerate && existing.includes('[')) {
            // Already has modem sections
            return { success: true, message: 'Config already exists', skipped: true };
        }

        const detected = await this.detectUsbPorts();
        if (!detected.modems || detected.modems.length === 0) {
            return { success: false, error: 'No modems detected' };
        }

        return this.applyQuectelConf({ modems: detected.modems });
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton ModemService instance
 */
function getModemService() {
    if (!instance) {
        instance = new ModemService();
    }
    return instance;
}

module.exports = {
    ModemService,
    getModemService,

    // Re-export constants
    MODEM_PROFILES,
    MAX_MODEMS,
    MAX_PIN_ATTEMPTS,

    // Re-export modules for direct access
    config,
    detection,
    asterisk,
    sms,
    sim,
    status,
    audio,
    volte,
    watchdog,
};
