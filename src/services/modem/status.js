/**
 * Status Collection Module
 * Collects modem status, statistics, and system information
 */

const os = require('os');
const logger = require('../../../utils/logger');
const { runCommand, asteriskCommand } = require('./utils');
const { MAX_PIN_ATTEMPTS } = require('./constants');
const { checkSimPin, getPinAttemptsRemaining } = require('./sim');
const { collectUsbInfo } = require('./detection');

/**
 * Collect status for a specific modem
 * @param {string} modemId - Modem ID
 * @param {Object} modemConfig - Modem configuration
 * @returns {Promise<Object>} Modem status
 */
async function collectModemStatus(modemId, modemConfig = {}) {
    const pinInfo = getPinAttemptsRemaining(modemId);

    const data = {
        id: modemId,
        name: modemConfig.modemName || modemId,
        number: modemConfig.phoneNumber || '',
        state: 'Unknown',
        stateMessage: '',
        needsPin: false,
        pinAttemptsRemaining: pinInfo.attemptsRemaining,
        pinLocked: pinInfo.isLocked,
        rssi: 0,
        rssiDbm: -113,
        rssiPercent: 0,
        technology: 'Unknown',
        operator: 'Unknown',
        registered: false,
        voice: false,
        sms: false,
        callsActive: 0,
        imei: '',
        model: '',
        cellId: '',
        lac: '',
    };

    try {
        const output = await asteriskCommand(`quectel show device state ${modemId}`);

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.includes(':')) continue;

            const colonIndex = trimmed.indexOf(':');
            const key = trimmed.substring(0, colonIndex).trim();
            const value = trimmed.substring(colonIndex + 1).trim();

            switch (key) {
                case 'State':
                    data.state = value;
                    if (value.toLowerCase().includes('not init')) {
                        data.stateMessage = 'PIN required or modem not connected';
                        data.needsPin = true;
                    } else if (value === 'Free') {
                        data.stateMessage = 'Ready';
                    } else if (value === 'Ring' || value === 'Dialing') {
                        data.stateMessage = 'In call';
                    }
                    break;
                case 'RSSI':
                    const rssiMatch = value.match(/(\d+),\s*(-?\d+)\s*dBm/);
                    if (rssiMatch) {
                        data.rssi = parseInt(rssiMatch[1]);
                        data.rssiDbm = parseInt(rssiMatch[2]);
                        data.rssiPercent = Math.min(100, Math.round((data.rssi / 31) * 100));
                    }
                    break;
                case 'Access technology':
                    data.technology = value;
                    break;
                case 'Provider Name':
                    if (value) data.operator = value;
                    break;
                case 'Network Name':
                    if (value && data.operator === 'Unknown') {
                        data.operator = value.split(' ')[0] || 'Unknown';
                    }
                    break;
                case 'GSM Registration Status':
                    data.registered = value.includes('Registered');
                    break;
                case 'Voice':
                    data.voice = value === 'Yes';
                    break;
                case 'SMS':
                    data.sms = value === 'Yes';
                    break;
                case 'Active':
                    data.callsActive = parseInt(value) || 0;
                    break;
                case 'Subscriber Number':
                    if (value) data.number = value;
                    break;
                case 'IMEI':
                    data.imei = value;
                    break;
                case 'Model':
                    data.model = value;
                    break;
                case 'Cell ID':
                    data.cellId = value;
                    break;
                case 'Location area code':
                    data.lac = value;
                    break;
            }
        }
    } catch (error) {
        data.error = error.message;
    }

    // Check PIN if modem not initialized
    if (data.state.toLowerCase().includes('not init') || data.state === 'Unknown') {
        try {
            const pinStatus = await checkSimPin(modemId, modemConfig.dataPort);
            if (pinStatus.needsPin) {
                data.needsPin = true;
                data.state = 'PIN required';
                data.stateMessage = 'Enter SIM PIN to activate modem';
            } else if (pinStatus.status === 'ready') {
                data.stateMessage = 'SIM unlocked - modem restarting...';
            } else if (pinStatus.status === 'puk_required') {
                data.state = 'SIM blocked';
                data.stateMessage = 'PUK required - SIM is blocked';
            }
        } catch (e) {
            // Ignore PIN check errors
        }
    }

    return data;
}

/**
 * Collect statistics for a modem
 * @param {string} modemId - Modem ID
 * @returns {Promise<Object>} Statistics
 */
async function collectModemStats(modemId) {
    const stats = {
        incomingCalls: 0,
        outgoingCalls: 0,
        answeredIncoming: 0,
        answeredOutgoing: 0,
        secondsIncoming: 0,
        secondsOutgoing: 0,
    };

    try {
        const output = await asteriskCommand(`quectel show device statistics ${modemId}`);

        for (const line of output.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed.includes(':')) continue;

            const colonIndex = trimmed.indexOf(':');
            const key = trimmed.substring(0, colonIndex).trim();
            const value = trimmed.substring(colonIndex + 1).trim();

            switch (key) {
                case 'Incoming calls':
                    stats.incomingCalls = parseInt(value) || 0;
                    break;
                case 'Attempts to outgoing calls':
                    stats.outgoingCalls = parseInt(value) || 0;
                    break;
                case 'Answered incoming calls':
                    stats.answeredIncoming = parseInt(value) || 0;
                    break;
                case 'Answered outgoing calls':
                    stats.answeredOutgoing = parseInt(value) || 0;
                    break;
                case 'Seconds of incoming calls':
                    stats.secondsIncoming = parseInt(value) || 0;
                    break;
                case 'Seconds of outgoing calls':
                    stats.secondsOutgoing = parseInt(value) || 0;
                    break;
            }
        }
    } catch (error) {
        stats.error = error.message;
    }

    return stats;
}

/**
 * Collect service status
 * @returns {Promise<Object>} Services status
 */
async function collectServices() {
    const services = {
        asterisk: { running: false, version: null },
        chanQuectel: { loaded: false },
        homenichat: { running: false },
    };

    try {
        // Check Asterisk
        const asteriskVersion = await runCommand('asterisk -rx "core show version" 2>/dev/null');
        if (asteriskVersion && !asteriskVersion.includes('Error')) {
            services.asterisk.running = true;
            const vMatch = asteriskVersion.match(/Asterisk\s+([\d.]+)/);
            services.asterisk.version = vMatch ? vMatch[1] : asteriskVersion.split('\n')[0];
        }

        // Check chan_quectel module
        const moduleList = await runCommand('asterisk -rx "module show like quectel" 2>/dev/null');
        services.chanQuectel.loaded = moduleList.includes('chan_quectel');

        // Check homenichat service
        const homenichatStatus = await runCommand('systemctl is-active homenichat 2>/dev/null || supervisorctl status homenichat 2>/dev/null');
        services.homenichat.running = homenichatStatus.includes('active') || homenichatStatus.includes('RUNNING');
    } catch (error) {
        logger.warn('[Status] Failed to collect services:', error.message);
    }

    return services;
}

/**
 * Collect system information
 * @returns {Object} System info
 */
function collectSystem() {
    const uptime = os.uptime();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
        hostname: os.hostname(),
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        uptime: uptime,
        uptimeFormatted: formatUptime(uptime),
        loadAverage: loadAvg.map(l => l.toFixed(2)),
        memory: {
            total: totalMem,
            free: freeMem,
            used: totalMem - freeMem,
            usedPercent: Math.round(((totalMem - freeMem) / totalMem) * 100),
        },
        cpus: os.cpus().length,
    };
}

/**
 * Format uptime to human-readable string
 */
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);

    let result = '';
    if (days > 0) result += `${days}d `;
    if (hours > 0) result += `${hours}h `;
    result += `${mins}m`;
    return result.trim();
}

/**
 * Collect all status information
 * @param {Object} modemsConfig - All modems configuration
 * @returns {Promise<Object>} Complete status
 */
async function collectAll(modemsConfig = {}) {
    const modemIds = Object.keys(modemsConfig);

    // Collect modem status in parallel
    const modemPromises = modemIds.map(id =>
        collectModemStatus(id, modemsConfig[id])
            .then(status => ({ ...status, stats: null }))
            .catch(err => ({ id, error: err.message }))
    );

    // Collect stats in parallel
    const statsPromises = modemIds.map(id =>
        collectModemStats(id).catch(err => ({ error: err.message }))
    );

    const [modems, stats, services, usb, system] = await Promise.all([
        Promise.all(modemPromises),
        Promise.all(statsPromises),
        collectServices(),
        collectUsbInfo(),
        Promise.resolve(collectSystem()),
    ]);

    // Merge stats into modems
    modems.forEach((modem, idx) => {
        if (modem && stats[idx]) {
            modem.stats = stats[idx];
        }
    });

    return {
        modems,
        services,
        usb,
        system,
        timestamp: new Date().toISOString(),
    };
}

module.exports = {
    collectModemStatus,
    collectModemStats,
    collectServices,
    collectSystem,
    collectAll,
    formatUptime,
};
