/**
 * ModemService - Gestion des modems GSM via chan_quectel/Asterisk
 * Inspiré du sms-monitor de VM500
 */

const { exec, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Configuration des modems (peut être surchargée par config)
const DEFAULT_MODEMS = {
  // Sera auto-détecté via asterisk
};

class ModemService {
  constructor(config = {}) {
    this.modems = config.modems || DEFAULT_MODEMS;
    this.asteriskHost = config.asteriskHost || 'localhost';
    this.watchdogLogPath = config.watchdogLogPath || '/var/log/smsgate-watchdog.log';
    this.metricsDb = null; // Pour l'historique
    this.logger = config.logger || console;
  }

  /**
   * Exécute une commande shell avec timeout
   */
  runCmd(cmd, timeout = 10000) {
    return new Promise((resolve) => {
      exec(cmd, { timeout }, (error, stdout, stderr) => {
        if (error) {
          resolve(`Error: ${error.message}`);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * Exécute une commande Asterisk CLI
   */
  async asteriskCmd(command) {
    return this.runCmd(`asterisk -rx '${command}' 2>/dev/null`);
  }

  /**
   * Liste les modems détectés par chan_quectel
   */
  async listModems() {
    const output = await this.asteriskCmd('quectel show devices');
    const modems = [];

    // Parser la sortie de "quectel show devices"
    const lines = output.split('\n');
    for (const line of lines) {
      if (line.includes('quectel-') || line.includes('Device')) {
        continue; // Skip headers
      }
      const match = line.match(/^(\S+)\s+/);
      if (match && match[1].startsWith('quectel')) {
        modems.push(match[1]);
      }
    }

    return modems;
  }

  /**
   * Collecte les données d'un modem spécifique
   */
  async collectModemStatus(modemId) {
    const config = this.modems[modemId] || {};
    const data = {
      id: modemId,
      name: config.name || modemId,
      number: config.number || '',
      sipPort: config.sipPort || 5060,
      state: 'Unknown',
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
      const output = await this.asteriskCmd(`quectel show device state ${modemId}`);

      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.includes(':')) continue;

        const colonIndex = trimmed.indexOf(':');
        const key = trimmed.substring(0, colonIndex).trim();
        const value = trimmed.substring(colonIndex + 1).trim();

        switch (key) {
          case 'State':
            data.state = value;
            break;
          case 'RSSI':
            // Format: "15, -83 dBm"
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

    return data;
  }

  /**
   * Collecte les statistiques d'un modem
   */
  async collectModemStats(modemId) {
    const stats = {
      incomingCalls: 0,
      outgoingCalls: 0,
      answeredIncoming: 0,
      answeredOutgoing: 0,
      secondsIncoming: 0,
      secondsOutgoing: 0,
    };

    try {
      const output = await this.asteriskCmd(`quectel show device statistics ${modemId}`);

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
   * Collecte l'état des services
   */
  async collectServices() {
    const services = {
      asterisk: { active: false, status: 'unknown' },
      smsBridge: { active: false, status: 'unknown' },
      smsGateway: { active: false, status: 'unknown' },
      watchdog: { active: false, status: 'unknown' },
      allOk: false,
    };

    const serviceMap = {
      asterisk: 'asterisk.service',
      smsBridge: 'sms-bridge.service',
      smsGateway: 'sms-gateway.service',
      watchdog: 'smsgate-watchdog.timer',
    };

    try {
      for (const [key, service] of Object.entries(serviceMap)) {
        const result = await this.runCmd(`systemctl is-active ${service} 2>/dev/null`);
        services[key].active = result === 'active';
        services[key].status = result;
      }

      services.allOk = Object.entries(services)
        .filter(([k]) => k !== 'allOk')
        .every(([, s]) => s.active);
    } catch (error) {
      services.error = error.message;
    }

    return services;
  }

  /**
   * Collecte les métriques système
   */
  collectSystem() {
    const data = {
      cpuPercent: 0,
      ramPercent: 0,
      ramUsedGb: 0,
      ramTotalGb: 0,
      diskPercent: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      uptimeSeconds: 0,
      uptimeHuman: '',
      loadAverage: [0, 0, 0],
    };

    try {
      // CPU (approximation via load average)
      const loadAvg = os.loadavg();
      data.loadAverage = loadAvg;
      const cpuCount = os.cpus().length;
      data.cpuPercent = Math.min(100, Math.round((loadAvg[0] / cpuCount) * 100));

      // RAM
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      data.ramTotalGb = Math.round((totalMem / (1024 ** 3)) * 10) / 10;
      data.ramUsedGb = Math.round((usedMem / (1024 ** 3)) * 10) / 10;
      data.ramPercent = Math.round((usedMem / totalMem) * 100);

      // Uptime
      data.uptimeSeconds = Math.floor(os.uptime());
      const days = Math.floor(data.uptimeSeconds / 86400);
      const hours = Math.floor((data.uptimeSeconds % 86400) / 3600);
      const minutes = Math.floor((data.uptimeSeconds % 3600) / 60);
      data.uptimeHuman = days > 0 ? `${days}j ${hours}h ${minutes}m` : `${hours}h ${minutes}m`;

      // Disk (root partition)
      try {
        const dfOutput = execSync('df -B1 / 2>/dev/null | tail -1').toString();
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
          const total = parseInt(parts[1]);
          const used = parseInt(parts[2]);
          data.diskTotalGb = Math.round((total / (1024 ** 3)) * 10) / 10;
          data.diskUsedGb = Math.round((used / (1024 ** 3)) * 10) / 10;
          data.diskPercent = Math.round((used / total) * 100);
        }
      } catch (e) {
        // Ignore disk errors
      }
    } catch (error) {
      data.error = error.message;
    }

    return data;
  }

  /**
   * Collecte l'état des ports USB
   */
  async collectUsb() {
    const data = {
      portsCount: 0,
      portsExpected: 10, // 5 ports par modem x 2 modems
      ports: [],
      symlinks: [],
      ok: false,
    };

    try {
      const result = await this.runCmd('ls /dev/ttyUSB* 2>/dev/null');
      if (result && !result.startsWith('Error') && !result.includes('No such file')) {
        const ports = result.split('\n').filter(p => p.trim());
        data.ports = ports.map(p => path.basename(p));
        data.portsCount = ports.length;
      }

      // Vérifier les symlinks
      const symlinkResult = await this.runCmd('ls /dev/quectel-* 2>/dev/null');
      if (symlinkResult && !symlinkResult.startsWith('Error') && !symlinkResult.includes('No such file')) {
        data.symlinks = symlinkResult.split('\n').filter(s => s.trim()).map(s => path.basename(s));
      }

      // OK si on a les symlinks attendus (ou au moins quelques ports)
      data.ok = data.portsCount > 0 && (data.symlinks.length >= 2 || data.portsCount >= 5);
    } catch (error) {
      data.error = error.message;
    }

    return data;
  }

  /**
   * Collecte les logs du watchdog
   */
  async collectWatchdogLogs(lines = 30) {
    const logs = [];

    try {
      const result = await this.runCmd(`tail -${lines} ${this.watchdogLogPath} 2>/dev/null`);

      for (const line of result.split('\n')) {
        if (!line.trim()) continue;

        // Format: "2026-01-15 12:00:00 [INFO] Message"
        const match = line.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[(\w+)\] (.+)/);
        if (match) {
          logs.push({
            timestamp: match[1],
            level: match[2],
            message: match[3],
          });
        }
      }
    } catch (error) {
      logs.push({ error: error.message });
    }

    return logs;
  }

  /**
   * Collecte toutes les données
   */
  async collectAll() {
    const modemIds = await this.listModems();
    const modems = {};

    for (const modemId of modemIds) {
      modems[modemId] = {
        status: await this.collectModemStatus(modemId),
        stats: await this.collectModemStats(modemId),
      };
    }

    // Si aucun modem détecté automatiquement, utiliser la config
    if (Object.keys(modems).length === 0 && Object.keys(this.modems).length > 0) {
      for (const modemId of Object.keys(this.modems)) {
        modems[modemId] = {
          status: await this.collectModemStatus(modemId),
          stats: await this.collectModemStats(modemId),
        };
      }
    }

    return {
      timestamp: new Date().toISOString(),
      modems,
      services: await this.collectServices(),
      system: this.collectSystem(),
      usb: await this.collectUsb(),
    };
  }

  // =============================================================================
  // ACTIONS
  // =============================================================================

  /**
   * Redémarre un modem
   */
  async restartModem(modemId) {
    const result = await this.asteriskCmd(`quectel restart now ${modemId}`);
    this.logger.info(`[ModemService] Restart modem ${modemId}: ${result}`);
    return { success: true, modem: modemId, result };
  }

  /**
   * Envoie une commande AT
   */
  async sendAtCommand(modemId, command) {
    if (!command.toUpperCase().startsWith('AT')) {
      throw new Error('Command must start with AT');
    }

    const result = await this.asteriskCmd(`quectel cmd ${modemId} ${command}`);
    this.logger.info(`[ModemService] AT command ${command} on ${modemId}: ${result}`);
    return { success: true, modem: modemId, command, result };
  }

  /**
   * Envoie un SMS
   */
  async sendSms(modemId, to, message) {
    if (!to || !message) {
      throw new Error('Missing "to" or "message"');
    }

    // Échapper les caractères spéciaux
    const safeMessage = message.replace(/"/g, '\\"').replace(/'/g, "\\'");
    const result = await this.asteriskCmd(`quectel sms ${modemId} ${to} "${safeMessage}"`);

    this.logger.info(`[ModemService] SMS sent via ${modemId} to ${to}`);
    return { success: true, modem: modemId, to, result };
  }

  /**
   * Configure l'audio 16kHz
   */
  async configureAudio(modemId) {
    const commands = [
      'AT+CPCMFRM=1',     // 16kHz PCM format
      'AT+CMICGAIN=0',    // Mic gain
      'AT+COUTGAIN=5',    // Output gain
      'AT+CTXVOL=0x2000', // TX volume
    ];

    const results = {};
    for (const cmd of commands) {
      results[cmd] = await this.asteriskCmd(`quectel cmd ${modemId} ${cmd}`);
    }

    this.logger.info(`[ModemService] Audio configured for ${modemId}`);
    return { success: true, modem: modemId, results };
  }

  /**
   * Redémarre Asterisk
   */
  async restartAsterisk() {
    const result = await this.runCmd('systemctl restart asterisk 2>/dev/null');
    this.logger.info(`[ModemService] Asterisk restarted: ${result}`);
    return { success: true, result: result || 'Asterisk restart initiated' };
  }

  /**
   * Redémarre tous les services
   */
  async restartAllServices() {
    const results = {};
    for (const service of ['asterisk', 'sms-bridge', 'sms-gateway']) {
      results[service] = await this.runCmd(`systemctl restart ${service} 2>/dev/null`);
    }

    this.logger.info('[ModemService] All services restarted');
    return { success: true, results };
  }
}

module.exports = ModemService;
