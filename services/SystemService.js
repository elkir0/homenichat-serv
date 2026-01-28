/**
 * SystemService - Manages system configuration (hostname, timezone)
 * Used by the first-run setup wizard
 */

const { execSync, exec } = require('child_process');
const os = require('os');
const logger = require('winston');

class SystemService {
    constructor() {
        if (SystemService.instance) {
            return SystemService.instance;
        }
        SystemService.instance = this;
    }

    /**
     * Get current hostname
     * @returns {string}
     */
    getHostname() {
        return os.hostname();
    }

    /**
     * Set system hostname (requires root/sudo)
     * @param {string} hostname - New hostname (lowercase, alphanumeric, hyphens)
     * @returns {{ success: boolean, error?: string }}
     */
    async setHostname(hostname) {
        // Validate hostname
        if (!this.validateHostname(hostname)) {
            return {
                success: false,
                error: 'Invalid hostname. Use lowercase letters, numbers, and hyphens only. Max 63 characters.'
            };
        }

        try {
            // Use hostnamectl if available (systemd)
            execSync(`hostnamectl set-hostname ${hostname}`, { encoding: 'utf-8' });
            logger.info(`Hostname changed to: ${hostname}`);
            return { success: true };
        } catch (error) {
            // Fallback: try directly setting /etc/hostname
            try {
                execSync(`echo "${hostname}" > /etc/hostname && hostname "${hostname}"`, { encoding: 'utf-8' });
                logger.info(`Hostname changed to: ${hostname} (fallback method)`);
                return { success: true };
            } catch (fallbackError) {
                logger.error('Failed to set hostname:', fallbackError.message);
                return {
                    success: false,
                    error: `Failed to set hostname: ${fallbackError.message}. Make sure you have root privileges.`
                };
            }
        }
    }

    /**
     * Validate hostname format
     * @param {string} hostname
     * @returns {boolean}
     */
    validateHostname(hostname) {
        if (!hostname || hostname.length > 63) return false;
        // RFC 1123: lowercase alphanumeric, hyphens, cannot start/end with hyphen
        return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(hostname);
    }

    /**
     * Get current timezone
     * @returns {string}
     */
    getTimezone() {
        try {
            const tz = execSync('timedatectl show --property=Timezone --value 2>/dev/null', { encoding: 'utf-8' }).trim();
            return tz || 'UTC';
        } catch {
            // Fallback: check /etc/timezone
            try {
                const tz = execSync('cat /etc/timezone 2>/dev/null', { encoding: 'utf-8' }).trim();
                return tz || 'UTC';
            } catch {
                return process.env.TZ || 'UTC';
            }
        }
    }

    /**
     * Get list of available timezones
     * @returns {string[]}
     */
    getAvailableTimezones() {
        try {
            const output = execSync('timedatectl list-timezones 2>/dev/null', { encoding: 'utf-8' });
            return output.trim().split('\n').filter(tz => tz);
        } catch {
            // Return common timezones as fallback
            return [
                'UTC',
                'America/New_York',
                'America/Chicago',
                'America/Denver',
                'America/Los_Angeles',
                'America/Guadeloupe',
                'America/Martinique',
                'Europe/London',
                'Europe/Paris',
                'Europe/Berlin',
                'Europe/Moscow',
                'Asia/Tokyo',
                'Asia/Shanghai',
                'Asia/Singapore',
                'Australia/Sydney',
                'Pacific/Auckland'
            ];
        }
    }

    /**
     * Get timezones grouped by region
     * @returns {Object<string, string[]>}
     */
    getGroupedTimezones() {
        const timezones = this.getAvailableTimezones();
        const grouped = {};

        for (const tz of timezones) {
            const parts = tz.split('/');
            const region = parts[0] || 'Other';
            if (!grouped[region]) {
                grouped[region] = [];
            }
            grouped[region].push(tz);
        }

        return grouped;
    }

    /**
     * Set system timezone (requires root/sudo)
     * @param {string} timezone - IANA timezone (e.g., 'Europe/Paris')
     * @returns {{ success: boolean, error?: string }}
     */
    async setTimezone(timezone) {
        const available = this.getAvailableTimezones();
        if (!available.includes(timezone)) {
            return {
                success: false,
                error: `Invalid timezone: ${timezone}`
            };
        }

        try {
            execSync(`timedatectl set-timezone ${timezone}`, { encoding: 'utf-8' });
            logger.info(`Timezone changed to: ${timezone}`);
            return { success: true };
        } catch (error) {
            // Fallback: symlink method
            try {
                execSync(`ln -sf /usr/share/zoneinfo/${timezone} /etc/localtime && echo "${timezone}" > /etc/timezone`, { encoding: 'utf-8' });
                logger.info(`Timezone changed to: ${timezone} (fallback method)`);
                return { success: true };
            } catch (fallbackError) {
                logger.error('Failed to set timezone:', fallbackError.message);
                return {
                    success: false,
                    error: `Failed to set timezone: ${fallbackError.message}. Make sure you have root privileges.`
                };
            }
        }
    }

    /**
     * Get current time in specified timezone (for preview)
     * @param {string} timezone
     * @returns {string}
     */
    getTimeInTimezone(timezone) {
        try {
            const now = new Date();
            return now.toLocaleString('en-US', {
                timeZone: timezone,
                weekday: 'short',
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        } catch {
            return 'Invalid timezone';
        }
    }

    /**
     * Get system information
     * @returns {Object}
     */
    getSystemInfo() {
        return {
            hostname: this.getHostname(),
            timezone: this.getTimezone(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            uptime: os.uptime(),
            totalMemory: os.totalmem(),
            freeMemory: os.freemem(),
            cpus: os.cpus().length,
            nodeVersion: process.version
        };
    }

    /**
     * Check if running as root
     * @returns {boolean}
     */
    isRoot() {
        return process.getuid && process.getuid() === 0;
    }

    /**
     * Check if systemd is available
     * @returns {boolean}
     */
    hasSystemd() {
        try {
            execSync('systemctl --version >/dev/null 2>&1');
            return true;
        } catch {
            return false;
        }
    }
}

module.exports = new SystemService();
