/**
 * Modem Watchdog Service
 *
 * Monitors modem health and applies progressive corrective actions.
 *
 * Escalation levels:
 * 1. SOFT     - AT command diagnostic (AT+CREG?, AT+CSQ)
 * 2. MEDIUM   - Modem reset via Asterisk (quectel reset)
 * 3. HARD     - Reload chan_quectel module
 * 4. CRITICAL - Restart Asterisk service
 * 5. MAXIMUM  - Reboot host system
 *
 * Each level has cooldowns and max attempts before escalating.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');
const { asteriskCommand, runCommand, sleep } = require('./utils');
const { getVoLTEStatus, enableVoLTE } = require('./volte');
const EventEmitter = require('events');

// Log file configuration
const LOG_CONFIG = {
    dir: process.env.DATA_DIR || '/var/lib/homenichat',
    filename: 'watchdog.log',
    maxSizeBytes: 5 * 1024 * 1024,  // 5 MB max
    maxBackups: 2,                   // Keep 2 backup files (.1, .2)
    maxMemoryEntries: 100,           // Max entries in memory history
};

/**
 * Watchdog Log Manager
 * Handles limited log file with rotation
 */
class WatchdogLogManager {
    constructor(config = LOG_CONFIG) {
        this.config = config;
        this.logPath = path.join(config.dir, config.filename);
        this.ensureLogDir();
    }

    ensureLogDir() {
        try {
            if (!fs.existsSync(this.config.dir)) {
                fs.mkdirSync(this.config.dir, { recursive: true });
            }
        } catch (e) {
            logger.warn('[Watchdog] Could not create log directory:', e.message);
        }
    }

    /**
     * Rotate log files if size exceeds limit
     */
    rotateIfNeeded() {
        try {
            if (!fs.existsSync(this.logPath)) return;

            const stats = fs.statSync(this.logPath);
            if (stats.size < this.config.maxSizeBytes) return;

            logger.info(`[Watchdog] Rotating log file (size: ${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

            // Rotate: .2 -> delete, .1 -> .2, current -> .1
            const backup2 = `${this.logPath}.2`;
            const backup1 = `${this.logPath}.1`;

            if (fs.existsSync(backup2)) {
                fs.unlinkSync(backup2);
            }
            if (fs.existsSync(backup1)) {
                fs.renameSync(backup1, backup2);
            }
            fs.renameSync(this.logPath, backup1);

        } catch (e) {
            logger.warn('[Watchdog] Log rotation failed:', e.message);
        }
    }

    /**
     * Write entry to log file
     */
    write(entry) {
        try {
            this.rotateIfNeeded();

            const line = JSON.stringify(entry) + '\n';
            fs.appendFileSync(this.logPath, line);

        } catch (e) {
            logger.warn('[Watchdog] Could not write to log file:', e.message);
        }
    }

    /**
     * Read recent log entries
     */
    readRecent(limit = 100) {
        try {
            if (!fs.existsSync(this.logPath)) return [];

            const content = fs.readFileSync(this.logPath, 'utf8');
            const lines = content.trim().split('\n').filter(l => l);

            // Get last N entries
            const recent = lines.slice(-limit);

            return recent.map(line => {
                try {
                    return JSON.parse(line);
                } catch {
                    return { raw: line };
                }
            }).reverse(); // Most recent first

        } catch (e) {
            logger.warn('[Watchdog] Could not read log file:', e.message);
            return [];
        }
    }

    /**
     * Get log file stats
     */
    getStats() {
        try {
            const stats = { exists: false, sizeBytes: 0, sizeMB: 0, entries: 0 };

            if (fs.existsSync(this.logPath)) {
                const fileStats = fs.statSync(this.logPath);
                stats.exists = true;
                stats.sizeBytes = fileStats.size;
                stats.sizeMB = (fileStats.size / 1024 / 1024).toFixed(2);

                // Count lines
                const content = fs.readFileSync(this.logPath, 'utf8');
                stats.entries = content.trim().split('\n').filter(l => l).length;
            }

            // Check backups
            stats.backups = [];
            for (let i = 1; i <= this.config.maxBackups; i++) {
                const backupPath = `${this.logPath}.${i}`;
                if (fs.existsSync(backupPath)) {
                    const backupStats = fs.statSync(backupPath);
                    stats.backups.push({
                        file: path.basename(backupPath),
                        sizeMB: (backupStats.size / 1024 / 1024).toFixed(2),
                    });
                }
            }

            stats.maxSizeMB = (this.config.maxSizeBytes / 1024 / 1024).toFixed(0);
            stats.path = this.logPath;

            return stats;

        } catch (e) {
            return { error: e.message };
        }
    }

    /**
     * Clear all log files
     */
    clear() {
        try {
            if (fs.existsSync(this.logPath)) {
                fs.unlinkSync(this.logPath);
            }
            for (let i = 1; i <= this.config.maxBackups; i++) {
                const backupPath = `${this.logPath}.${i}`;
                if (fs.existsSync(backupPath)) {
                    fs.unlinkSync(backupPath);
                }
            }
            logger.info('[Watchdog] Log files cleared');
            return { success: true };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
}

// Escalation levels
const ESCALATION_LEVELS = {
    NONE: 0,
    SOFT: 1,
    MEDIUM: 2,
    HARD: 3,
    CRITICAL: 4,
    MAXIMUM: 5,
};

const LEVEL_NAMES = ['NONE', 'SOFT', 'MEDIUM', 'HARD', 'CRITICAL', 'MAXIMUM'];

// Default configuration
const DEFAULT_CONFIG = {
    enabled: true,
    checkIntervalMs: 60000,           // Check every 60 seconds
    healthyResetIntervalMs: 300000,   // Reset escalation after 5 min healthy

    // Thresholds for problem detection
    thresholds: {
        maxConsecutiveFailures: 3,    // Failures before escalating
        minRssi: 5,                   // Minimum acceptable RSSI (0-31)
        maxNoSignalMinutes: 5,        // Max minutes with RSSI=0
        maxNotInitMinutes: 2,         // Max minutes in "Not init" state
        maxNoProviderMinutes: 3,      // Max minutes without provider
        smsdbMaxMessages: 1000,       // Max SMS in smsdb before cleanup
    },

    // Cooldowns between actions (prevent action spam)
    cooldowns: {
        [ESCALATION_LEVELS.SOFT]: 30000,      // 30 sec
        [ESCALATION_LEVELS.MEDIUM]: 120000,   // 2 min
        [ESCALATION_LEVELS.HARD]: 300000,     // 5 min
        [ESCALATION_LEVELS.CRITICAL]: 600000, // 10 min
        [ESCALATION_LEVELS.MAXIMUM]: 1800000, // 30 min
    },

    // Max attempts per level before escalating
    maxAttemptsPerLevel: {
        [ESCALATION_LEVELS.SOFT]: 3,
        [ESCALATION_LEVELS.MEDIUM]: 2,
        [ESCALATION_LEVELS.HARD]: 2,
        [ESCALATION_LEVELS.CRITICAL]: 1,
        [ESCALATION_LEVELS.MAXIMUM]: 1,  // Only one reboot attempt
    },

    // Enable/disable specific levels
    enabledLevels: {
        [ESCALATION_LEVELS.SOFT]: true,
        [ESCALATION_LEVELS.MEDIUM]: true,
        [ESCALATION_LEVELS.HARD]: true,
        [ESCALATION_LEVELS.CRITICAL]: true,
        [ESCALATION_LEVELS.MAXIMUM]: true,  // Set to false to disable host reboot
    },
};

/**
 * ModemWatchdog class
 */
class ModemWatchdog extends EventEmitter {
    constructor(config = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.config.thresholds = { ...DEFAULT_CONFIG.thresholds, ...config.thresholds };
        this.config.cooldowns = { ...DEFAULT_CONFIG.cooldowns, ...config.cooldowns };
        this.config.maxAttemptsPerLevel = { ...DEFAULT_CONFIG.maxAttemptsPerLevel, ...config.maxAttemptsPerLevel };
        this.config.enabledLevels = { ...DEFAULT_CONFIG.enabledLevels, ...config.enabledLevels };

        // State tracking per modem
        this.modemStates = new Map();

        // Global state
        this.running = false;
        this.checkInterval = null;
        this.lastGlobalAction = null;
        this.globalActionCount = 0;

        // History for logging/debugging (in-memory, limited)
        this.actionHistory = [];
        this.maxHistoryLength = LOG_CONFIG.maxMemoryEntries;

        // File-based log manager with rotation
        this.logManager = new WatchdogLogManager();

        logger.info('[Watchdog] Initialized with config:', {
            checkInterval: this.config.checkIntervalMs,
            maxRebootEnabled: this.config.enabledLevels[ESCALATION_LEVELS.MAXIMUM],
        });
    }

    /**
     * Get or create state for a modem
     */
    getModemState(modemId) {
        if (!this.modemStates.has(modemId)) {
            this.modemStates.set(modemId, {
                modemId,
                currentLevel: ESCALATION_LEVELS.NONE,
                consecutiveFailures: 0,
                attemptsAtCurrentLevel: 0,
                lastActionTime: {},
                lastHealthyTime: Date.now(),
                problemStartTime: null,
                problemType: null,
                lastStatus: null,
            });
        }
        return this.modemStates.get(modemId);
    }

    /**
     * Start the watchdog
     */
    start() {
        if (this.running) {
            logger.warn('[Watchdog] Already running');
            return;
        }

        this.running = true;
        logger.info('[Watchdog] Starting modem watchdog service...');

        // Initial check after 30 seconds (let system stabilize)
        setTimeout(() => {
            if (this.running) {
                this.runHealthCheck();
            }
        }, 30000);

        // Regular checks
        this.checkInterval = setInterval(() => {
            if (this.running) {
                this.runHealthCheck();
            }
        }, this.config.checkIntervalMs);

        this.emit('started');
    }

    /**
     * Stop the watchdog
     */
    stop() {
        if (!this.running) return;

        this.running = false;
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        logger.info('[Watchdog] Stopped');
        this.emit('stopped');
    }

    /**
     * Run health check on all modems
     */
    async runHealthCheck() {
        try {
            const modems = await this.getConfiguredModems();

            if (modems.length === 0) {
                logger.debug('[Watchdog] No modems configured');
                return;
            }

            for (const modemId of modems) {
                await this.checkModemHealth(modemId);
            }

        } catch (error) {
            logger.error('[Watchdog] Health check error:', error.message);
        }
    }

    /**
     * Get list of configured modems
     */
    async getConfiguredModems() {
        try {
            const { getModemService } = require('./index');
            const modemService = getModemService();
            const config = modemService.getAllModemsConfig();
            return Object.keys(config || {});
        } catch (error) {
            logger.warn('[Watchdog] Could not get modem config:', error.message);
            return [];
        }
    }

    /**
     * Check health of a specific modem
     */
    async checkModemHealth(modemId) {
        const state = this.getModemState(modemId);
        const now = Date.now();

        try {
            // Get modem status from Asterisk
            const status = await this.getModemStatus(modemId);
            state.lastStatus = status;

            // Analyze status and detect problems
            const problem = this.detectProblem(modemId, status, state);

            if (problem) {
                // Problem detected
                state.consecutiveFailures++;

                if (!state.problemStartTime) {
                    state.problemStartTime = now;
                    state.problemType = problem.type;
                }

                logger.warn(`[Watchdog] ${modemId}: Problem detected - ${problem.type}: ${problem.message}`);

                // Check if we need to escalate
                if (state.consecutiveFailures >= this.config.thresholds.maxConsecutiveFailures) {
                    await this.handleProblem(modemId, problem, state);
                }

            } else {
                // Modem is healthy
                if (state.currentLevel > ESCALATION_LEVELS.NONE) {
                    logger.info(`[Watchdog] ${modemId}: Recovered! Resetting escalation level.`);

                    // Log recovery event
                    this.logEvent('recovery', modemId, `Recovered from ${state.problemType}`, {
                        previousLevel: state.currentLevel,
                        previousLevelName: LEVEL_NAMES[state.currentLevel],
                        problemDuration: state.problemStartTime ? Math.round((now - state.problemStartTime) / 1000) : 0,
                    });
                }

                state.consecutiveFailures = 0;
                state.currentLevel = ESCALATION_LEVELS.NONE;
                state.attemptsAtCurrentLevel = 0;
                state.lastHealthyTime = now;
                state.problemStartTime = null;
                state.problemType = null;
            }

        } catch (error) {
            logger.error(`[Watchdog] ${modemId}: Check failed - ${error.message}`);
            state.consecutiveFailures++;
        }
    }

    /**
     * Get modem status from Asterisk
     */
    async getModemStatus(modemId) {
        const status = {
            modemId,
            state: 'Unknown',
            rssi: 0,
            registered: false,
            provider: null,
            voice: false,
            sms: false,
            volteEnabled: false,
            volteActive: false,
            error: null,
        };

        try {
            const output = await asteriskCommand(`quectel show device state ${modemId}`);

            if (output.includes('No such device')) {
                status.state = 'Not found';
                status.error = 'Device not found in Asterisk';
                return status;
            }

            // Parse status
            for (const line of output.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed.includes(':')) continue;

                const [key, ...valueParts] = trimmed.split(':');
                const value = valueParts.join(':').trim();

                switch (key.trim()) {
                    case 'State':
                        status.state = value;
                        break;
                    case 'RSSI':
                        const rssiMatch = value.match(/(\d+)/);
                        if (rssiMatch) status.rssi = parseInt(rssiMatch[1]);
                        break;
                    case 'GSM Registration Status':
                        status.registered = value.includes('Registered');
                        break;
                    case 'Provider Name':
                    case 'Network Name':
                        if (value && value !== 'Unknown') status.provider = value;
                        break;
                    case 'Voice':
                        status.voice = value === 'Yes';
                        break;
                    case 'SMS':
                        status.sms = value === 'Yes';
                        break;
                }
            }

            // Check VoLTE status if applicable
            try {
                const { getModemService } = require('./index');
                const modemService = getModemService();
                const modemConfig = modemService.getModemConfig(modemId);

                if (modemConfig.volteEnabled) {
                    status.volteEnabled = true;
                    const volteStatus = await getVoLTEStatus(modemId);
                    status.volteActive = volteStatus.volteEnabled;
                }
            } catch (e) {
                // Ignore VoLTE check errors
            }

        } catch (error) {
            status.error = error.message;
        }

        return status;
    }

    /**
     * Detect problems with modem
     */
    detectProblem(modemId, status, state) {
        const now = Date.now();
        const thresholds = this.config.thresholds;

        // Problem: Device not found
        if (status.state === 'Not found' || status.error?.includes('not found')) {
            return { type: 'NOT_FOUND', message: 'Modem not found in Asterisk', severity: 'high' };
        }

        // Problem: Not initialized (PIN required or hardware issue)
        if (status.state.toLowerCase().includes('not init')) {
            const duration = state.problemStartTime ? (now - state.problemStartTime) / 60000 : 0;
            if (duration >= thresholds.maxNotInitMinutes) {
                return { type: 'NOT_INIT', message: `Not initialized for ${duration.toFixed(1)} min`, severity: 'high' };
            }
        }

        // Problem: No signal
        if (status.rssi === 0) {
            const duration = state.problemStartTime ? (now - state.problemStartTime) / 60000 : 0;
            if (duration >= thresholds.maxNoSignalMinutes) {
                return { type: 'NO_SIGNAL', message: `No signal (RSSI=0) for ${duration.toFixed(1)} min`, severity: 'medium' };
            }
        }

        // Problem: Very weak signal
        if (status.rssi > 0 && status.rssi < thresholds.minRssi) {
            return { type: 'WEAK_SIGNAL', message: `Weak signal (RSSI=${status.rssi})`, severity: 'low' };
        }

        // Problem: Not registered
        if (!status.registered && status.state === 'Free') {
            const duration = state.problemStartTime ? (now - state.problemStartTime) / 60000 : 0;
            if (duration >= thresholds.maxNoProviderMinutes) {
                return { type: 'NOT_REGISTERED', message: `Not registered for ${duration.toFixed(1)} min`, severity: 'medium' };
            }
        }

        // Problem: No provider
        if (!status.provider && status.state === 'Free') {
            const duration = state.problemStartTime ? (now - state.problemStartTime) / 60000 : 0;
            if (duration >= thresholds.maxNoProviderMinutes) {
                return { type: 'NO_PROVIDER', message: `No provider for ${duration.toFixed(1)} min`, severity: 'medium' };
            }
        }

        // Problem: VoLTE should be active but isn't
        if (status.volteEnabled && !status.volteActive && status.state === 'Free') {
            return { type: 'VOLTE_INACTIVE', message: 'VoLTE enabled but not active', severity: 'low' };
        }

        return null; // No problem
    }

    /**
     * Handle detected problem with progressive response
     */
    async handleProblem(modemId, problem, state) {
        const now = Date.now();

        // Determine what level to use
        let targetLevel = state.currentLevel;

        // Check if we should escalate
        if (state.attemptsAtCurrentLevel >= this.config.maxAttemptsPerLevel[state.currentLevel]) {
            targetLevel = Math.min(state.currentLevel + 1, ESCALATION_LEVELS.MAXIMUM);
            state.attemptsAtCurrentLevel = 0;
            logger.warn(`[Watchdog] ${modemId}: Escalating to level ${LEVEL_NAMES[targetLevel]}`);
        }

        // If at NONE, start at SOFT
        if (targetLevel === ESCALATION_LEVELS.NONE) {
            targetLevel = ESCALATION_LEVELS.SOFT;
        }

        // Check if level is enabled
        if (!this.config.enabledLevels[targetLevel]) {
            logger.warn(`[Watchdog] ${modemId}: Level ${LEVEL_NAMES[targetLevel]} is disabled, skipping`);
            return;
        }

        // Check cooldown
        const lastAction = state.lastActionTime[targetLevel] || 0;
        const cooldown = this.config.cooldowns[targetLevel];

        if (now - lastAction < cooldown) {
            const remaining = Math.round((cooldown - (now - lastAction)) / 1000);
            logger.debug(`[Watchdog] ${modemId}: Cooldown for ${LEVEL_NAMES[targetLevel]}, ${remaining}s remaining`);
            return;
        }

        // Execute action
        state.currentLevel = targetLevel;
        state.attemptsAtCurrentLevel++;
        state.lastActionTime[targetLevel] = now;

        const action = await this.executeAction(modemId, targetLevel, problem);

        // Log action
        this.logAction(modemId, targetLevel, problem, action);

        // Emit event
        this.emit('action', {
            modemId,
            level: targetLevel,
            levelName: LEVEL_NAMES[targetLevel],
            problem,
            action,
            timestamp: now,
        });
    }

    /**
     * Execute corrective action at specified level
     */
    async executeAction(modemId, level, problem) {
        const action = {
            level,
            levelName: LEVEL_NAMES[level],
            success: false,
            message: '',
            details: null,
        };

        try {
            switch (level) {
                case ESCALATION_LEVELS.SOFT:
                    action.message = 'Diagnostic AT commands';
                    action.details = await this.actionSoft(modemId, problem);
                    action.success = true;
                    break;

                case ESCALATION_LEVELS.MEDIUM:
                    action.message = 'Modem reset (quectel reset)';
                    action.details = await this.actionMedium(modemId);
                    action.success = true;
                    break;

                case ESCALATION_LEVELS.HARD:
                    action.message = 'Reload chan_quectel module';
                    action.details = await this.actionHard();
                    action.success = true;
                    break;

                case ESCALATION_LEVELS.CRITICAL:
                    action.message = 'Restart Asterisk service';
                    action.details = await this.actionCritical();
                    action.success = true;
                    break;

                case ESCALATION_LEVELS.MAXIMUM:
                    action.message = 'REBOOT HOST SYSTEM';
                    action.details = await this.actionMaximum();
                    action.success = true;
                    break;
            }

            logger.info(`[Watchdog] ${modemId}: Executed ${action.levelName} - ${action.message}`);

        } catch (error) {
            action.success = false;
            action.error = error.message;
            logger.error(`[Watchdog] ${modemId}: Action ${action.levelName} failed - ${error.message}`);
        }

        return action;
    }

    /**
     * Level 1: SOFT - Diagnostic AT commands
     */
    async actionSoft(modemId, problem) {
        const results = {};

        // Send diagnostic commands
        try {
            results.creg = await asteriskCommand(`quectel cmd ${modemId} AT+CREG?`);
        } catch (e) {
            results.creg = `Error: ${e.message}`;
        }

        try {
            results.csq = await asteriskCommand(`quectel cmd ${modemId} AT+CSQ`);
        } catch (e) {
            results.csq = `Error: ${e.message}`;
        }

        try {
            results.cops = await asteriskCommand(`quectel cmd ${modemId} AT+COPS?`);
        } catch (e) {
            results.cops = `Error: ${e.message}`;
        }

        // If VoLTE problem, try to re-enable
        if (problem.type === 'VOLTE_INACTIVE') {
            try {
                logger.info(`[Watchdog] ${modemId}: Re-enabling VoLTE...`);
                const volteResult = await enableVoLTE(modemId);
                results.volte = volteResult.success ? 'Re-enabled' : volteResult.error;
            } catch (e) {
                results.volte = `Error: ${e.message}`;
            }
        }

        return results;
    }

    /**
     * Level 2: MEDIUM - Reset modem via Asterisk
     */
    async actionMedium(modemId) {
        logger.warn(`[Watchdog] ${modemId}: Resetting modem...`);

        const result = await asteriskCommand(`quectel reset ${modemId}`);

        // Wait for modem to come back
        await sleep(10000);

        return { reset: result };
    }

    /**
     * Level 3: HARD - Reload chan_quectel module
     */
    async actionHard() {
        logger.warn('[Watchdog] Reloading chan_quectel module...');

        // Try reload first
        let result = await asteriskCommand('module reload chan_quectel');

        // If that fails, try unload/load
        if (result.includes('Error') || result.includes('Unable')) {
            logger.warn('[Watchdog] Reload failed, trying unload/load...');
            await asteriskCommand('module unload chan_quectel');
            await sleep(2000);
            result = await asteriskCommand('module load chan_quectel.so');
        }

        // Wait for modems to be detected
        await sleep(15000);

        return { reload: result };
    }

    /**
     * Level 4: CRITICAL - Restart Asterisk service
     */
    async actionCritical() {
        logger.error('[Watchdog] CRITICAL: Restarting Asterisk service...');

        const result = await runCommand('systemctl restart asterisk');

        // Wait for Asterisk to come back
        await sleep(30000);

        return { restart: result };
    }

    /**
     * Level 5: MAXIMUM - Reboot host system
     */
    async actionMaximum() {
        logger.error('[Watchdog] MAXIMUM: REBOOTING HOST SYSTEM IN 10 SECONDS...');

        // Log the reboot reason
        const reason = `Modem watchdog escalation - all recovery attempts failed`;
        try {
            await runCommand(`echo "[$(date)] ${reason}" >> /var/log/homenichat-watchdog-reboot.log`);
        } catch (e) {
            // Ignore log errors
        }

        // Emit warning event
        this.emit('reboot_imminent', { reason, countdown: 10 });

        // Wait 10 seconds to allow notifications
        await sleep(10000);

        // Execute reboot
        const result = await runCommand('shutdown -r now "Homenichat watchdog: modem recovery failed"');

        return { reboot: result, reason };
    }

    /**
     * Log action to history (memory + file)
     */
    logAction(modemId, level, problem, action) {
        const entry = {
            timestamp: new Date().toISOString(),
            modemId,
            level,
            levelName: LEVEL_NAMES[level],
            problemType: problem.type,
            problemMessage: problem.message,
            actionSuccess: action.success,
            actionMessage: action.message,
        };

        // Add to in-memory history (limited)
        this.actionHistory.unshift(entry);
        if (this.actionHistory.length > this.maxHistoryLength) {
            this.actionHistory = this.actionHistory.slice(0, this.maxHistoryLength);
        }

        // Write to file (with rotation)
        this.logManager.write(entry);
    }

    /**
     * Log a health check event (only errors/warnings, not every check)
     */
    logEvent(type, modemId, message, details = null) {
        const entry = {
            timestamp: new Date().toISOString(),
            type,
            modemId,
            message,
            details,
        };

        // Only write significant events to file
        if (type === 'error' || type === 'warning' || type === 'recovery') {
            this.logManager.write(entry);
        }
    }

    /**
     * Get watchdog status
     */
    getStatus() {
        const modemStates = {};
        this.modemStates.forEach((state, modemId) => {
            modemStates[modemId] = {
                currentLevel: state.currentLevel,
                currentLevelName: LEVEL_NAMES[state.currentLevel],
                consecutiveFailures: state.consecutiveFailures,
                attemptsAtCurrentLevel: state.attemptsAtCurrentLevel,
                problemType: state.problemType,
                problemStartTime: state.problemStartTime,
                lastHealthyTime: state.lastHealthyTime,
                lastStatus: state.lastStatus,
            };
        });

        return {
            running: this.running,
            config: {
                checkIntervalMs: this.config.checkIntervalMs,
                maxRebootEnabled: this.config.enabledLevels[ESCALATION_LEVELS.MAXIMUM],
            },
            modemStates,
            recentActions: this.actionHistory.slice(0, 20),
            logStats: this.logManager.getStats(),
        };
    }

    /**
     * Get log file statistics
     */
    getLogStats() {
        return this.logManager.getStats();
    }

    /**
     * Read recent entries from log file
     */
    getLogFileHistory(limit = 100) {
        return this.logManager.readRecent(limit);
    }

    /**
     * Clear all log files
     */
    clearLogs() {
        const result = this.logManager.clear();
        this.actionHistory = []; // Also clear in-memory
        return result;
    }

    /**
     * Get action history
     */
    getHistory(limit = 50) {
        return this.actionHistory.slice(0, limit);
    }

    /**
     * Reset escalation for a modem
     */
    resetEscalation(modemId) {
        const state = this.modemStates.get(modemId);
        if (state) {
            state.currentLevel = ESCALATION_LEVELS.NONE;
            state.consecutiveFailures = 0;
            state.attemptsAtCurrentLevel = 0;
            state.problemStartTime = null;
            state.problemType = null;
            logger.info(`[Watchdog] ${modemId}: Escalation reset manually`);
        }
    }

    /**
     * Force action at specific level (for testing/manual intervention)
     */
    async forceAction(modemId, level) {
        if (level < ESCALATION_LEVELS.SOFT || level > ESCALATION_LEVELS.MAXIMUM) {
            throw new Error(`Invalid level: ${level}`);
        }

        logger.warn(`[Watchdog] ${modemId}: Forcing action at level ${LEVEL_NAMES[level]}`);

        const problem = { type: 'MANUAL', message: 'Manual intervention', severity: 'high' };
        const action = await this.executeAction(modemId, level, problem);

        this.logAction(modemId, level, problem, action);

        return action;
    }

    /**
     * Cleanup smsdb (can be called periodically or on demand)
     */
    async cleanupSmsdb() {
        try {
            logger.info('[Watchdog] Cleaning up smsdb...');

            // Get smsdb stats
            const stats = await runCommand('ls -la /var/lib/asterisk/smsdb/ 2>/dev/null | wc -l');
            const fileCount = parseInt(stats) || 0;

            if (fileCount > this.config.thresholds.smsdbMaxMessages) {
                // Remove old files (keep last 100)
                await runCommand('cd /var/lib/asterisk/smsdb && ls -t | tail -n +101 | xargs rm -f 2>/dev/null || true');
                logger.info(`[Watchdog] Cleaned smsdb: removed ${fileCount - 100} old files`);
                return { cleaned: true, removed: fileCount - 100 };
            }

            return { cleaned: false, fileCount };

        } catch (error) {
            logger.warn('[Watchdog] smsdb cleanup failed:', error.message);
            return { cleaned: false, error: error.message };
        }
    }
}

// Singleton instance
let instance = null;

/**
 * Get singleton watchdog instance
 */
function getWatchdog(config = {}) {
    if (!instance) {
        instance = new ModemWatchdog(config);
    }
    return instance;
}

/**
 * Start watchdog (convenience function)
 */
function startWatchdog(config = {}) {
    const watchdog = getWatchdog(config);
    watchdog.start();
    return watchdog;
}

/**
 * Stop watchdog (convenience function)
 */
function stopWatchdog() {
    if (instance) {
        instance.stop();
    }
}

module.exports = {
    ModemWatchdog,
    getWatchdog,
    startWatchdog,
    stopWatchdog,
    ESCALATION_LEVELS,
    LEVEL_NAMES,
};
