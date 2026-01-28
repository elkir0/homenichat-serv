/**
 * NetworkService - Manages network configuration via nmcli
 * Used by the first-run setup wizard
 */

const { execSync, exec } = require('child_process');
const os = require('os');
const logger = require('winston');

class NetworkService {
    constructor() {
        if (NetworkService.instance) {
            return NetworkService.instance;
        }
        NetworkService.instance = this;
    }

    /**
     * Check if NetworkManager (nmcli) is available
     * @returns {boolean}
     */
    isNmcliAvailable() {
        try {
            execSync('which nmcli >/dev/null 2>&1');
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Get list of network interfaces
     * @returns {Array<{ name: string, type: string, state: string, connection: string }>}
     */
    getInterfaces() {
        try {
            const output = execSync('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device', { encoding: 'utf-8' });
            return output.trim().split('\n')
                .filter(line => line)
                .map(line => {
                    const [name, type, state, connection] = line.split(':');
                    return { name, type, state, connection: connection || null };
                })
                .filter(iface => iface.type === 'ethernet' || iface.type === 'wifi');
        } catch (error) {
            logger.warn('Failed to get network interfaces via nmcli:', error.message);
            // Fallback: use os.networkInterfaces()
            const interfaces = os.networkInterfaces();
            return Object.keys(interfaces)
                .filter(name => name !== 'lo')
                .map(name => ({
                    name,
                    type: 'unknown',
                    state: 'unknown',
                    connection: null
                }));
        }
    }

    /**
     * Get current network configuration for an interface
     * @param {string} interfaceName - Interface name (e.g., 'eth0')
     * @returns {{ method: string, ip?: string, gateway?: string, dns?: string[] }}
     */
    getInterfaceConfig(interfaceName) {
        try {
            // Get connection name for this device
            const connName = execSync(`nmcli -t -f NAME con show --active | head -1`, { encoding: 'utf-8' }).trim();

            if (!connName) {
                return this.getInterfaceConfigFallback(interfaceName);
            }

            // Get connection details
            const ipMethod = execSync(`nmcli -t -f ipv4.method con show "${connName}" 2>/dev/null | cut -d: -f2`, { encoding: 'utf-8' }).trim();
            const ipAddr = execSync(`nmcli -t -f IP4.ADDRESS con show "${connName}" 2>/dev/null | head -1 | cut -d: -f2`, { encoding: 'utf-8' }).trim();
            const gateway = execSync(`nmcli -t -f IP4.GATEWAY con show "${connName}" 2>/dev/null | head -1 | cut -d: -f2`, { encoding: 'utf-8' }).trim();
            const dnsRaw = execSync(`nmcli -t -f IP4.DNS con show "${connName}" 2>/dev/null | cut -d: -f2`, { encoding: 'utf-8' }).trim();

            const dns = dnsRaw ? dnsRaw.split('\n').filter(d => d) : [];

            return {
                connectionName: connName,
                method: ipMethod === 'auto' ? 'dhcp' : 'static',
                ip: ipAddr || undefined,
                gateway: gateway || undefined,
                dns
            };
        } catch (error) {
            logger.warn('Failed to get interface config via nmcli:', error.message);
            return this.getInterfaceConfigFallback(interfaceName);
        }
    }

    /**
     * Fallback method to get interface config using ip command
     * @param {string} interfaceName
     * @returns {{ method: string, ip?: string, gateway?: string, dns?: string[] }}
     */
    getInterfaceConfigFallback(interfaceName) {
        try {
            const ipOutput = execSync(`ip addr show ${interfaceName} 2>/dev/null | grep 'inet ' | awk '{print $2}'`, { encoding: 'utf-8' }).trim();
            const gatewayOutput = execSync(`ip route | grep default | awk '{print $3}'`, { encoding: 'utf-8' }).trim();

            let dns = [];
            try {
                const resolvConf = execSync('cat /etc/resolv.conf 2>/dev/null | grep nameserver | awk \'{print $2}\'', { encoding: 'utf-8' }).trim();
                dns = resolvConf.split('\n').filter(d => d && !d.startsWith('#'));
            } catch {}

            return {
                method: 'unknown',
                ip: ipOutput || undefined,
                gateway: gatewayOutput || undefined,
                dns
            };
        } catch {
            return { method: 'unknown' };
        }
    }

    /**
     * Get the primary connection name
     * @returns {string|null}
     */
    getPrimaryConnection() {
        try {
            return execSync('nmcli -t -f NAME con show --active | head -1', { encoding: 'utf-8' }).trim() || null;
        } catch {
            return null;
        }
    }

    /**
     * Configure network interface to use DHCP
     * @param {string} connectionName - Connection name (not interface name)
     * @returns {{ success: boolean, error?: string }}
     */
    async setDhcp(connectionName) {
        if (!this.isNmcliAvailable()) {
            return {
                success: false,
                error: 'NetworkManager (nmcli) is not available on this system'
            };
        }

        try {
            // Set to auto (DHCP)
            execSync(`nmcli con mod "${connectionName}" ipv4.method auto`, { encoding: 'utf-8' });
            // Clear any static IP settings
            execSync(`nmcli con mod "${connectionName}" ipv4.addresses ""`, { encoding: 'utf-8' });
            execSync(`nmcli con mod "${connectionName}" ipv4.gateway ""`, { encoding: 'utf-8' });
            execSync(`nmcli con mod "${connectionName}" ipv4.dns ""`, { encoding: 'utf-8' });
            // Restart connection
            execSync(`nmcli con up "${connectionName}"`, { encoding: 'utf-8' });

            logger.info(`Network connection "${connectionName}" set to DHCP`);
            return { success: true };
        } catch (error) {
            logger.error('Failed to set DHCP:', error.message);
            return {
                success: false,
                error: `Failed to configure DHCP: ${error.message}`
            };
        }
    }

    /**
     * Configure network interface with static IP
     * @param {string} connectionName - Connection name
     * @param {{ ip: string, gateway: string, dns: string[] }} config - Static IP configuration
     * @returns {{ success: boolean, error?: string }}
     */
    async setStaticIp(connectionName, config) {
        if (!this.isNmcliAvailable()) {
            return {
                success: false,
                error: 'NetworkManager (nmcli) is not available on this system'
            };
        }

        const { ip, gateway, dns } = config;

        // Validate IP format (CIDR notation required: 192.168.1.100/24)
        if (!this.validateIpCidr(ip)) {
            return {
                success: false,
                error: 'Invalid IP address format. Use CIDR notation (e.g., 192.168.1.100/24)'
            };
        }

        // Validate gateway
        if (!this.validateIp(gateway)) {
            return {
                success: false,
                error: 'Invalid gateway address'
            };
        }

        // Validate DNS
        const dnsServers = dns.filter(d => this.validateIp(d));

        try {
            // Set static IP
            execSync(`nmcli con mod "${connectionName}" ipv4.addresses "${ip}"`, { encoding: 'utf-8' });
            execSync(`nmcli con mod "${connectionName}" ipv4.gateway "${gateway}"`, { encoding: 'utf-8' });
            execSync(`nmcli con mod "${connectionName}" ipv4.method manual`, { encoding: 'utf-8' });

            if (dnsServers.length > 0) {
                execSync(`nmcli con mod "${connectionName}" ipv4.dns "${dnsServers.join(',')}"`, { encoding: 'utf-8' });
            }

            // Restart connection
            execSync(`nmcli con up "${connectionName}"`, { encoding: 'utf-8' });

            logger.info(`Network connection "${connectionName}" configured with static IP: ${ip}`);
            return { success: true };
        } catch (error) {
            logger.error('Failed to set static IP:', error.message);
            return {
                success: false,
                error: `Failed to configure static IP: ${error.message}`
            };
        }
    }

    /**
     * Validate IP address format
     * @param {string} ip
     * @returns {boolean}
     */
    validateIp(ip) {
        if (!ip) return false;
        const parts = ip.split('.');
        if (parts.length !== 4) return false;
        return parts.every(part => {
            const num = parseInt(part, 10);
            return !isNaN(num) && num >= 0 && num <= 255;
        });
    }

    /**
     * Validate IP address in CIDR notation
     * @param {string} ipCidr - IP in CIDR notation (e.g., '192.168.1.100/24')
     * @returns {boolean}
     */
    validateIpCidr(ipCidr) {
        if (!ipCidr) return false;
        const parts = ipCidr.split('/');
        if (parts.length !== 2) return false;
        const [ip, prefix] = parts;
        if (!this.validateIp(ip)) return false;
        const prefixNum = parseInt(prefix, 10);
        return !isNaN(prefixNum) && prefixNum >= 0 && prefixNum <= 32;
    }

    /**
     * Get current IP addresses for all interfaces
     * @returns {Object<string, string[]>}
     */
    getAllIpAddresses() {
        const interfaces = os.networkInterfaces();
        const result = {};

        for (const [name, addrs] of Object.entries(interfaces)) {
            if (name === 'lo') continue;
            result[name] = addrs
                .filter(addr => addr.family === 'IPv4')
                .map(addr => addr.address);
        }

        return result;
    }

    /**
     * Get the primary IP address (first non-localhost IPv4)
     * @returns {string|null}
     */
    getPrimaryIpAddress() {
        const interfaces = os.networkInterfaces();

        for (const addrs of Object.values(interfaces)) {
            for (const addr of addrs) {
                if (addr.family === 'IPv4' && !addr.internal) {
                    return addr.address;
                }
            }
        }

        return null;
    }

    /**
     * Check network connectivity
     * @param {string} host - Host to ping (default: 8.8.8.8)
     * @returns {{ success: boolean, latency?: number }}
     */
    async checkConnectivity(host = '8.8.8.8') {
        return new Promise(resolve => {
            exec(`ping -c 1 -W 5 ${host}`, (error, stdout) => {
                if (error) {
                    resolve({ success: false });
                    return;
                }

                // Parse latency from ping output
                const match = stdout.match(/time=(\d+\.?\d*)/);
                const latency = match ? parseFloat(match[1]) : undefined;

                resolve({ success: true, latency });
            });
        });
    }

    /**
     * Get network summary for setup display
     * @returns {Object}
     */
    getNetworkSummary() {
        const interfaces = this.getInterfaces();
        const primaryConnection = this.getPrimaryConnection();
        let config = null;

        if (primaryConnection) {
            const primaryInterface = interfaces.find(i => i.connection === primaryConnection);
            if (primaryInterface) {
                config = this.getInterfaceConfig(primaryInterface.name);
            }
        }

        return {
            nmcliAvailable: this.isNmcliAvailable(),
            interfaces,
            primaryConnection,
            primaryIp: this.getPrimaryIpAddress(),
            currentConfig: config
        };
    }
}

module.exports = new NetworkService();
