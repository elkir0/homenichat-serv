/**
 * Asterisk Manager Interface (AMI) Module
 * Handles connection, authentication, and event handling
 */

const net = require('net');
const EventEmitter = require('events');
const logger = require('../../../utils/logger');
const {
    AMI_DEFAULT_HOST,
    AMI_DEFAULT_PORT,
    AMI_DEFAULT_USERNAME,
    AMI_RECONNECT_DELAY,
    AMI_MAX_RECONNECT_ATTEMPTS,
} = require('./constants');

/**
 * AMI Connection Class
 */
class AmiConnection extends EventEmitter {
    constructor(config = {}) {
        super();

        this.config = {
            host: config.host || process.env.AMI_HOST || AMI_DEFAULT_HOST,
            port: parseInt(config.port || process.env.AMI_PORT) || AMI_DEFAULT_PORT,
            username: config.username || process.env.AMI_USER || process.env.AMI_USERNAME || AMI_DEFAULT_USERNAME,
            password: config.password || process.env.AMI_SECRET || process.env.AMI_PASSWORD || '',
        };

        this.socket = null;
        this.connected = false;
        this.authenticated = false;
        this.reconnectTimer = null;
        this.reconnectAttempts = 0;
        this.dataBuffer = '';
    }

    /**
     * Start the AMI connection
     */
    start() {
        if (!this.config.host || !this.config.username) {
            logger.warn('[AMI] Configuration missing, service disabled');
            return false;
        }

        logger.info(`[AMI] Connecting to ${this.config.host}:${this.config.port}`);
        this.connect();
        return true;
    }

    /**
     * Connect to AMI
     */
    connect() {
        this.socket = new net.Socket();

        this.socket.on('connect', () => {
            logger.info('[AMI] Connected');
            this.connected = true;
            this.reconnectAttempts = 0;
        });

        this.socket.on('data', (data) => {
            this.handleData(data.toString());
        });

        this.socket.on('close', () => {
            logger.warn('[AMI] Connection closed');
            this.connected = false;
            this.authenticated = false;
            this.scheduleReconnect();
        });

        this.socket.on('error', (err) => {
            logger.error('[AMI] Socket error:', err.message);
            this.connected = false;
            this.authenticated = false;
        });

        this.socket.connect(this.config.port, this.config.host);
    }

    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectTimer) return;

        if (this.reconnectAttempts >= AMI_MAX_RECONNECT_ATTEMPTS) {
            logger.error('[AMI] Max reconnect attempts reached');
            this.emit('maxReconnectAttempts');
            return;
        }

        this.reconnectAttempts++;
        const delay = AMI_RECONNECT_DELAY * Math.min(this.reconnectAttempts, 5);

        logger.info(`[AMI] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, delay);
    }

    /**
     * Handle incoming data
     */
    handleData(data) {
        this.dataBuffer += data;

        // Events are separated by double newline
        const messages = this.dataBuffer.split('\r\n\r\n');

        // Keep last incomplete message in buffer
        this.dataBuffer = messages.pop();

        for (const message of messages) {
            if (!message.trim()) continue;

            // Check for login prompt
            if (message.includes('Asterisk Call Manager')) {
                this.login();
                continue;
            }

            const event = this.parseEvent(message);
            if (event) {
                this.handleEvent(event);
            }
        }
    }

    /**
     * Parse AMI event string into object
     */
    parseEvent(eventStr) {
        const event = {};
        const lines = eventStr.split('\r\n');

        for (const line of lines) {
            const colonIndex = line.indexOf(':');
            if (colonIndex > 0) {
                const key = line.substring(0, colonIndex).trim();
                const value = line.substring(colonIndex + 1).trim();
                event[key] = value;
            }
        }

        return Object.keys(event).length > 0 ? event : null;
    }

    /**
     * Handle parsed event
     */
    handleEvent(event) {
        // Handle authentication response
        if (event.Response === 'Success' && event.Message?.includes('Authentication')) {
            logger.info('[AMI] Authenticated successfully');
            this.authenticated = true;
            this.emit('authenticated');
            return;
        }

        if (event.Response === 'Error') {
            logger.error('[AMI] Error:', event.Message);
            this.emit('error', new Error(event.Message));
            return;
        }

        // Emit event for handlers
        if (event.Event) {
            this.emit('event', event);
            this.emit(`event:${event.Event}`, event);
        }
    }

    /**
     * Send login action
     */
    login() {
        const loginAction = [
            'Action: Login',
            `Username: ${this.config.username}`,
            `Secret: ${this.config.password}`,
            'Events: on',
            '',
            '',
        ].join('\r\n');

        this.socket.write(loginAction);
        logger.info('[AMI] Login sent');
    }

    /**
     * Send action to AMI
     * @param {Object} action - Action parameters
     * @returns {Promise<Object>} Response
     */
    sendAction(action) {
        return new Promise((resolve, reject) => {
            if (!this.authenticated) {
                reject(new Error('Not authenticated'));
                return;
            }

            const actionId = Date.now().toString();
            let actionStr = `Action: ${action.action}\r\nActionID: ${actionId}\r\n`;

            for (const [key, value] of Object.entries(action)) {
                if (key !== 'action') {
                    actionStr += `${key}: ${value}\r\n`;
                }
            }
            actionStr += '\r\n';

            // Set up response handler
            const responseHandler = (event) => {
                if (event.ActionID === actionId) {
                    this.removeListener('event', responseHandler);
                    if (event.Response === 'Error') {
                        reject(new Error(event.Message));
                    } else {
                        resolve(event);
                    }
                }
            };

            this.on('event', responseHandler);

            // Timeout
            setTimeout(() => {
                this.removeListener('event', responseHandler);
                reject(new Error('Action timeout'));
            }, 10000);

            this.socket.write(actionStr);
        });
    }

    /**
     * Send CLI command via AMI
     * @param {string} command - Asterisk CLI command
     * @returns {Promise<string>} Command output
     */
    async sendCommand(command) {
        const response = await this.sendAction({
            action: 'Command',
            Command: command,
        });
        return response.Output || '';
    }

    /**
     * Reload module
     * @param {string} module - Module name (e.g., 'res_pjsip')
     */
    async reloadModule(module) {
        return this.sendAction({
            action: 'ModuleReload',
            Module: module,
        });
    }

    /**
     * Get connection status
     */
    getStatus() {
        return {
            connected: this.connected,
            authenticated: this.authenticated,
            host: this.config.host,
            port: this.config.port,
        };
    }

    /**
     * Stop the connection
     */
    stop() {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }

        this.connected = false;
        this.authenticated = false;
    }
}

module.exports = {
    AmiConnection,
};
