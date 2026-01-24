/**
 * Modem Detection Module
 * Handles USB device detection and modem type identification
 */

const { execSync } = require('child_process');
const logger = require('../../../utils/logger');
const { runCommand } = require('./utils');

/**
 * Detect modem type from USB devices
 * @returns {string|null} 'sim7600', 'ec25', or null
 */
function detectModemType() {
    try {
        const lsusbOutput = execSync('lsusb 2>/dev/null', { encoding: 'utf8', timeout: 5000 });

        // SIM7600: vendor ID 1e0e (Simcom/Qualcomm)
        if (lsusbOutput.includes('1e0e:9001') || lsusbOutput.includes('1e0e:9011') ||
            lsusbOutput.toLowerCase().includes('simcom') || lsusbOutput.toLowerCase().includes('sim7600')) {
            logger.info('[ModemDetection] Auto-detected modem type: SIM7600');
            return 'sim7600';
        }

        // EC25: vendor ID 2c7c (Quectel)
        if (lsusbOutput.includes('2c7c:0125') || lsusbOutput.toLowerCase().includes('quectel')) {
            logger.info('[ModemDetection] Auto-detected modem type: EC25');
            return 'ec25';
        }

        // Fallback: check port count
        const portsResult = execSync('ls /dev/ttyUSB* 2>/dev/null | wc -l', { encoding: 'utf8', timeout: 3000 });
        const portCount = parseInt(portsResult.trim()) || 0;

        // 5+ ports usually means SIM7600, 3-4 ports usually EC25
        if (portCount >= 5) {
            logger.info('[ModemDetection] Detected SIM7600 from port count (5+ ports)');
            return 'sim7600';
        } else if (portCount >= 3) {
            logger.info('[ModemDetection] Detected EC25 from port count (3-4 ports)');
            return 'ec25';
        }

        return null;
    } catch (error) {
        logger.warn('[ModemDetection] Failed to auto-detect modem type:', error.message);
        return null;
    }
}

/**
 * Detect USB ports and modems
 * @returns {Promise<Object>} Detection results with ports and suggested configs
 */
async function detectUsbPorts() {
    const detected = {
        ports: [],
        suggestedDataPort: null,
        suggestedAudioPort: null,
        modemType: null,
        modems: [],
    };

    try {
        // List all ttyUSB ports
        const result = await runCommand('ls /dev/ttyUSB* 2>/dev/null');
        if (result && !result.startsWith('Error') && !result.includes('No such file')) {
            detected.ports = result.split('\n').filter(p => p.trim()).map(p => p.trim());
        }

        // Get USB device info
        const usbDevices = await runCommand('lsusb 2>/dev/null');

        // Count modems by vendor ID
        const sim7600Count = (usbDevices.match(/1e0e:9001/gi) || []).length;
        const ec25Count = (usbDevices.match(/2c7c:0125/gi) || []).length;

        // SIM7600 detection
        if (usbDevices.includes('1e0e:9001') || usbDevices.includes('1e0e:9011') ||
            usbDevices.toLowerCase().includes('simcom')) {
            detected.modemType = 'sim7600';

            if (detected.ports.includes('/dev/ttyUSB2')) {
                detected.suggestedDataPort = '/dev/ttyUSB2';
            }
            if (detected.ports.includes('/dev/ttyUSB4')) {
                detected.suggestedAudioPort = '/dev/ttyUSB4';
            }

            // SIM7600: 5 ports per modem, data=USB2, audio=USB4
            if (sim7600Count >= 1) {
                detected.modems.push({
                    id: 'modem-1',
                    type: 'SIM7600',
                    dataPort: '/dev/ttyUSB2',
                    audioPort: '/dev/ttyUSB4',
                });
            }
            if (sim7600Count >= 2) {
                detected.modems.push({
                    id: 'modem-2',
                    type: 'SIM7600',
                    dataPort: '/dev/ttyUSB7',
                    audioPort: '/dev/ttyUSB9',
                });
            }
        }
        // EC25 detection
        else if (usbDevices.includes('2c7c:0125') || usbDevices.toLowerCase().includes('quectel')) {
            detected.modemType = 'ec25';

            if (detected.ports.includes('/dev/ttyUSB2')) {
                detected.suggestedDataPort = '/dev/ttyUSB2';
            }
            if (detected.ports.includes('/dev/ttyUSB1')) {
                detected.suggestedAudioPort = '/dev/ttyUSB1';
            }

            if (ec25Count >= 1) {
                detected.modems.push({
                    id: 'modem-1',
                    type: 'EC25',
                    dataPort: '/dev/ttyUSB2',
                    audioPort: '/dev/ttyUSB1',
                });
            }
        }

        // Fallback detection based on port count
        if (!detected.modemType && detected.ports.length >= 3) {
            if (detected.ports.length >= 5) {
                detected.modemType = 'sim7600';
                detected.suggestedDataPort = '/dev/ttyUSB2';
                detected.suggestedAudioPort = '/dev/ttyUSB4';
                detected.modems.push({
                    id: 'modem-1',
                    type: 'SIM7600',
                    dataPort: '/dev/ttyUSB2',
                    audioPort: '/dev/ttyUSB4',
                });
                if (detected.ports.length >= 10) {
                    detected.modems.push({
                        id: 'modem-2',
                        type: 'SIM7600',
                        dataPort: '/dev/ttyUSB7',
                        audioPort: '/dev/ttyUSB9',
                    });
                }
            } else {
                detected.modemType = 'ec25';
                detected.suggestedDataPort = '/dev/ttyUSB2';
                detected.suggestedAudioPort = '/dev/ttyUSB1';
            }
        }
    } catch (error) {
        detected.error = error.message;
    }

    return detected;
}

/**
 * Collect USB device information for status
 */
async function collectUsbInfo() {
    try {
        const [lsusb, ttyPorts] = await Promise.all([
            runCommand('lsusb 2>/dev/null').catch(() => ''),
            runCommand('ls -la /dev/ttyUSB* 2>/dev/null').catch(() => ''),
        ]);

        const devices = [];
        if (lsusb) {
            for (const line of lsusb.split('\n')) {
                if (line.includes('1e0e:') || line.includes('2c7c:')) {
                    devices.push(line.trim());
                }
            }
        }

        const ports = [];
        if (ttyPorts) {
            for (const line of ttyPorts.split('\n')) {
                if (line.includes('ttyUSB')) {
                    ports.push(line.trim());
                }
            }
        }

        return { devices, ports };
    } catch (error) {
        logger.warn('[ModemDetection] Failed to collect USB info:', error.message);
        return { devices: [], ports: [], error: error.message };
    }
}

/**
 * Calculate audio port based on data port and modem type
 */
function calculateAudioPort(dataPort, modemType) {
    const match = dataPort.match(/ttyUSB(\d+)/);
    if (!match) return null;

    const dataNum = parseInt(match[1]);

    // SIM7600: audio = data + 2
    // EC25: audio = data - 1
    if (modemType === 'sim7600') {
        return `/dev/ttyUSB${dataNum + 2}`;
    } else {
        return `/dev/ttyUSB${Math.max(0, dataNum - 1)}`;
    }
}

module.exports = {
    detectModemType,
    detectUsbPorts,
    collectUsbInfo,
    calculateAudioPort,
};
