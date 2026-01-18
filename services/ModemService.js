/**
 * ModemService - Gestion des modems GSM via chan_quectel/Asterisk
 * Inspiré du sms-monitor de VM500
 *
 * Supporte:
 * - EC25 (Quectel) - Audio 8kHz
 * - SIM7600 (Simcom) - Audio 16kHz
 */

const { exec, execSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');

// Configuration des modems (peut être surchargée par config)
const DEFAULT_MODEMS = {
  // Sera auto-détecté via asterisk
};

// Configurations par type de modem
const MODEM_PROFILES = {
  ec25: {
    name: 'Quectel EC25',
    slin16: false,  // 8kHz audio
    msg_storage: 'me',
    disableSMS: false,
    audioCommands: [
      'AT+QAUDMOD=2',     // Mode PCM (pas USB audio)
      'AT+CPCMFRM=0',     // 8kHz PCM format
      'AT+CLVL=3',        // Volume speaker
    ],
    portOffset: {
      data: 2,  // ttyUSB2 pour EC25
      audio: 1, // ttyUSB1 pour EC25
    },
  },
  sim7600: {
    name: 'Simcom SIM7600',
    slin16: true,   // 16kHz audio
    msg_storage: 'me',
    disableSMS: false,
    audioCommands: [
      'AT+CPCMFRM=1',     // 16kHz PCM format
      'AT+CMICGAIN=0',
      'AT+COUTGAIN=5',
      'AT+CTXVOL=0x2000',
    ],
    portOffset: {
      data: 3,  // ttyUSB3 pour SIM7600
      audio: 2, // ttyUSB2 pour SIM7600
    },
  },
};

// Chemin de configuration
const CONFIG_DIR = '/var/lib/homenichat';
const MODEM_CONFIG_FILE = path.join(CONFIG_DIR, 'modem-config.json');
const QUECTEL_CONF_PATH = '/etc/asterisk/quectel.conf';

// PIN attempt tracking (max 2 attempts before requiring admin reset)
const MAX_PIN_ATTEMPTS = 2;
let pinAttempts = 0;
let pinLocked = false;

class ModemService {
  constructor(config = {}) {
    this.modems = config.modems || DEFAULT_MODEMS;
    this.asteriskHost = config.asteriskHost || 'localhost';
    this.watchdogLogPath = config.watchdogLogPath || '/var/log/smsgate-watchdog.log';
    this.metricsDb = null; // Pour l'historique
    this.logger = config.logger || console;

    // Charger la configuration modem persistante
    this.modemConfig = this.loadModemConfig();
  }

  /**
   * Charge la configuration modem depuis le fichier
   */
  loadModemConfig() {
    try {
      if (fs.existsSync(MODEM_CONFIG_FILE)) {
        const data = fs.readFileSync(MODEM_CONFIG_FILE, 'utf8');
        const config = JSON.parse(data);
        // Auto-detect modem type if not set or if autoDetect is enabled
        if (!config.modemType || config.autoDetect) {
          const detectedType = this.detectModemTypeFromUsb();
          if (detectedType) {
            config.modemType = detectedType;
          }
        }
        return config;
      }
    } catch (error) {
      this.logger.error('[ModemService] Error loading modem config:', error);
    }

    // Auto-detect modem type for default config
    const detectedType = this.detectModemTypeFromUsb();

    // Configuration par défaut
    return {
      modemType: detectedType || 'sim7600', // Default to sim7600 if detection fails
      modemName: 'hni-modem',
      phoneNumber: '',
      pinCode: '',
      dataPort: '/dev/ttyUSB2',
      audioPort: detectedType === 'ec25' ? '/dev/ttyUSB1' : '/dev/ttyUSB4',  // SIM7600: USB4, EC25: USB1
      autoDetect: true,
      // Configuration SMS
      sms: {
        enabled: true,
        storage: 'sqlite',      // 'sqlite' | 'modem' | 'sim'
        autoDelete: true,       // Supprimer du modem après lecture
        deliveryReports: false, // Accusés de réception
        serviceCenter: '',      // Auto-détecté si vide
        encoding: 'auto',       // 'auto' | 'gsm7' | 'ucs2'
      },
    };
  }

  /**
   * Détecte le type de modem depuis les informations USB
   * @returns {string|null} 'sim7600' ou 'ec25' ou null
   */
  detectModemTypeFromUsb() {
    try {
      const lsusbOutput = execSync('lsusb 2>/dev/null', { encoding: 'utf8', timeout: 5000 });

      // SIM7600: vendor ID 1e0e (Simcom/Qualcomm)
      if (lsusbOutput.includes('1e0e:9001') || lsusbOutput.includes('1e0e:9011') ||
          lsusbOutput.toLowerCase().includes('simcom') || lsusbOutput.toLowerCase().includes('sim7600')) {
        this.logger.info('[ModemService] Auto-detected modem type: SIM7600');
        return 'sim7600';
      }

      // EC25: vendor ID 2c7c (Quectel)
      if (lsusbOutput.includes('2c7c:0125') || lsusbOutput.toLowerCase().includes('quectel')) {
        this.logger.info('[ModemService] Auto-detected modem type: EC25');
        return 'ec25';
      }

      // Check number of ttyUSB ports as fallback
      const portsResult = execSync('ls /dev/ttyUSB* 2>/dev/null | wc -l', { encoding: 'utf8', timeout: 3000 });
      const portCount = parseInt(portsResult.trim()) || 0;

      // 5+ ports usually means SIM7600, 3-4 ports usually EC25
      if (portCount >= 5) {
        this.logger.info('[ModemService] Auto-detected modem type from port count: SIM7600 (5+ ports)');
        return 'sim7600';
      } else if (portCount >= 3) {
        this.logger.info('[ModemService] Auto-detected modem type from port count: EC25 (3-4 ports)');
        return 'ec25';
      }

      return null;
    } catch (error) {
      this.logger.warn('[ModemService] Failed to auto-detect modem type:', error.message);
      return null;
    }
  }

  /**
   * Sauvegarde la configuration modem
   */
  saveModemConfig(config) {
    try {
      // Créer le répertoire si nécessaire
      if (!fs.existsSync(CONFIG_DIR)) {
        fs.mkdirSync(CONFIG_DIR, { recursive: true });
      }

      this.modemConfig = { ...this.modemConfig, ...config };
      fs.writeFileSync(MODEM_CONFIG_FILE, JSON.stringify(this.modemConfig, null, 2));
      this.logger.info('[ModemService] Modem config saved');
      return true;
    } catch (error) {
      this.logger.error('[ModemService] Error saving modem config:', error);
      throw error;
    }
  }

  /**
   * Récupère la configuration actuelle
   */
  getModemConfig() {
    return { ...this.modemConfig };
  }

  /**
   * Exécute une commande shell avec timeout
   */
  runCmd(cmd, timeout = 10000) {
    return new Promise((resolve) => {
      exec(cmd, { timeout }, (error, stdout, stderr) => {
        // Toujours retourner stdout s'il y en a, même en cas d'erreur
        // Car certaines commandes (comme asterisk -rx) retournent un code non-zéro
        // mais ont quand même un résultat valide sur stdout
        if (stdout && stdout.trim()) {
          resolve(stdout.trim());
        } else if (error) {
          resolve(`Error: ${error.message}`);
        } else {
          resolve('');
        }
      });
    });
  }

  /**
   * Exécute une commande Asterisk CLI
   */
  async asteriskCmd(command) {
    // Utiliser le chemin complet car asterisk peut ne pas être dans le PATH
    return this.runCmd(`/usr/sbin/asterisk -rx '${command}'`);
  }

  /**
   * Liste les modems détectés par chan_quectel
   */
  async listModems() {
    const output = await this.asteriskCmd('quectel show devices');
    const modems = [];

    // Skip if Asterisk returned an error or is not running
    if (!output ||
        output.startsWith('Error') ||
        output.includes('/bin/sh:') ||
        output.includes('Unable to connect') ||
        output.includes('command not found') ||
        output.includes('No such file') ||
        output.includes('not running') ||
        output.includes('not available')) {
      this.logger.warn('[ModemService] Asterisk not available or chan_quectel not loaded:', output?.substring(0, 100));
      return modems;
    }

    // Parser la sortie de "quectel show devices"
    // Format: ID           Group State      RSSI Mode Provide Model...
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines, header line, and error messages
      if (!trimmed ||
          trimmed.startsWith('ID') ||
          trimmed.includes('Group State') ||
          trimmed.startsWith('Error') ||
          trimmed.startsWith('/bin/sh') ||
          trimmed.startsWith('Unable') ||
          trimmed.includes('not found') ||
          trimmed.includes('No ')) {
        continue;
      }
      // Extract modem ID (first column)
      // Valid modem IDs are alphanumeric with optional hyphens (e.g., "quectel-modem", "hni-modem")
      const match = trimmed.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s+/);
      if (match && match[1]) {
        const modemId = match[1];
        // Additional validation: modem ID should be reasonable length
        if (modemId.length >= 2 && modemId.length <= 32) {
          modems.push(modemId);
        }
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
      stateMessage: '',
      needsPin: false,
      pinAttemptsRemaining: MAX_PIN_ATTEMPTS - pinAttempts,
      pinLocked: pinLocked,
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
            // Améliorer le message d'état
            if (value.toLowerCase().includes('not init')) {
              data.stateMessage = 'Code PIN requis ou modem non connecté';
              data.needsPin = true; // Probablement besoin du PIN
            } else if (value === 'Free') {
              data.stateMessage = 'Prêt';
            } else if (value === 'Ring' || value === 'Dialing') {
              data.stateMessage = 'En communication';
            }
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

    // Si modem non initialisé, vérifier le PIN directement
    if (data.state.toLowerCase().includes('not init') || data.state === 'Unknown') {
      try {
        const pinStatus = await this.checkSimPin(modemId);
        if (pinStatus.needsPin) {
          data.needsPin = true;
          data.state = 'PIN requis';
          data.stateMessage = 'Entrez le code PIN de la carte SIM pour activer le modem';
        } else if (pinStatus.status === 'ready') {
          data.stateMessage = 'SIM déverrouillée - redémarrage modem en cours...';
        } else if (pinStatus.status === 'puk_required') {
          data.state = 'SIM bloquée';
          data.stateMessage = 'Code PUK requis - la carte SIM est bloquée';
        }
      } catch (e) {
        // Ignorer les erreurs de vérification PIN
      }
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
      portsExpected: 4, // EC25: 4 ports, SIM7600: 5 ports
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

      // OK si on a au moins 3 ports USB (minimum pour un modem)
      data.ok = data.portsCount >= 3;
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
   * Envoie un SMS via Asterisk chan_quectel
   * Syntaxe: quectel sms send <device> <number> <message>
   */
  async sendSms(modemId, to, message) {
    if (!to || !message) {
      throw new Error('Missing "to" or "message"');
    }

    // Essayer d'abord via Asterisk (config VM500 style)
    try {
      const safeMessage = message.replace(/"/g, '\\"').replace(/'/g, "\\'");
      const result = await this.asteriskCmd(`quectel sms send ${modemId} ${to} "${safeMessage}"`);

      if (result && result.includes('queued')) {
        this.logger.info(`[ModemService] SMS queued via Asterisk ${modemId} to ${to}`);
        return { success: true, modem: modemId, to, method: 'asterisk', result };
      }

      // Si pas "queued", vérifier si c'est une erreur
      if (result && (result.includes('not found') || result.includes('error'))) {
        throw new Error(result);
      }

      this.logger.info(`[ModemService] SMS sent via Asterisk ${modemId} to ${to}`);
      return { success: true, modem: modemId, to, method: 'asterisk', result };

    } catch (asteriskError) {
      // Fallback: envoi direct via AT commands (pour debug ou si Asterisk down)
      this.logger.warn(`[ModemService] Asterisk SMS failed, trying direct AT: ${asteriskError.message}`);

      const dataPort = this.modemConfig.dataPort || '/dev/ttyUSB2';

      try {
        const pythonScript = `
import serial
import time
import sys

port = "${dataPort}"
phone = "${to}"
message = """${message.replace(/"/g, '\\"')}"""

try:
    ser = serial.Serial(port, 115200, timeout=5)
    time.sleep(0.3)
    ser.flushInput()
    ser.write(b"AT+CMGF=1\\r\\n")
    time.sleep(0.5)
    r = ser.read(100).decode(errors="ignore")
    if "OK" not in r:
        print("ERROR: CMGF failed")
        sys.exit(1)
    cmd = 'AT+CMGS="' + phone + '"\\r\\n'
    ser.write(cmd.encode())
    time.sleep(2)
    ser.write((message + chr(26)).encode())
    time.sleep(15)
    r = ser.read(500).decode(errors="ignore")
    ser.close()
    if "+CMGS" in r or "OK" in r:
        print("OK")
        sys.exit(0)
    else:
        print("ERROR: " + r.replace("\\n", " "))
        sys.exit(1)
except Exception as e:
    print("ERROR: " + str(e))
    sys.exit(1)
`;
        const result = await this.runCmd(`python3 -c '${pythonScript.replace(/'/g, "'\"'\"'")}'`, 30000);

        if (result && result.includes('OK')) {
          this.logger.info(`[ModemService] SMS sent directly via ${dataPort} to ${to}`);
          return { success: true, modem: modemId, to, method: 'direct-at' };
        } else {
          throw new Error(result || 'Unknown error');
        }
      } catch (directError) {
        this.logger.error(`[ModemService] All SMS methods failed for ${to}`);
        throw new Error(`SMS failed: Asterisk (${asteriskError.message}), Direct (${directError.message})`);
      }
    }
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

  // =============================================================================
  // CONFIGURATION MODEM (EC25/SIM7600, PIN, Ports)
  // =============================================================================

  /**
   * Récupère les profils de modem disponibles
   */
  getModemProfiles() {
    return Object.entries(MODEM_PROFILES).map(([id, profile]) => ({
      id,
      name: profile.name,
      slin16: profile.slin16,
      description: profile.slin16 ? 'Audio 16kHz (haute qualité)' : 'Audio 8kHz (standard)',
    }));
  }

  /**
   * Détecte automatiquement les ports USB des modems
   */
  async detectUsbPorts() {
    const detected = {
      ports: [],
      suggestedDataPort: null,
      suggestedAudioPort: null,
      modemType: null,
      modems: [], // Liste des modems détectés
    };

    try {
      // Lister tous les ports ttyUSB
      const result = await this.runCmd('ls /dev/ttyUSB* 2>/dev/null');
      if (result && !result.startsWith('Error') && !result.includes('No such file')) {
        detected.ports = result.split('\n').filter(p => p.trim()).map(p => p.trim());
      }

      // Chercher des indices sur le type de modem via USB vendor/product
      const usbDevices = await this.runCmd('lsusb 2>/dev/null');

      // Compter les modems SIM7600 (vendor 1e0e)
      const sim7600Count = (usbDevices.match(/1e0e:9001/gi) || []).length;
      // Compter les modems EC25 (vendor 2c7c)
      const ec25Count = (usbDevices.match(/2c7c:0125/gi) || []).length;

      // SIM7600 detection (priority - vendor ID 1e0e)
      if (usbDevices.includes('1e0e:9001') || usbDevices.includes('1e0e:9011') ||
          usbDevices.toLowerCase().includes('simcom')) {
        detected.modemType = 'sim7600';
        // SIM7600: data=ttyUSB2 (port AT), audio=ttyUSB1
        // Pour 2 modems: modem1=ttyUSB0-4, modem2=ttyUSB5-9
        if (detected.ports.includes('/dev/ttyUSB2')) {
          detected.suggestedDataPort = '/dev/ttyUSB2';
        }
        if (detected.ports.includes('/dev/ttyUSB1')) {
          detected.suggestedAudioPort = '/dev/ttyUSB1';
        }

        // Ajouter les modems détectés
        // SIM7600: 5 ports par modem, data=USB2, audio=USB4
        if (sim7600Count >= 1) {
          detected.modems.push({
            id: 'modem-1',
            type: 'SIM7600',
            dataPort: '/dev/ttyUSB2',
            audioPort: '/dev/ttyUSB4',  // SIM7600 audio is USB+4, not USB+1
          });
        }
        if (sim7600Count >= 2) {
          detected.modems.push({
            id: 'modem-2',
            type: 'SIM7600',
            dataPort: '/dev/ttyUSB7',
            audioPort: '/dev/ttyUSB9',  // Second modem: USB7+2=USB9
          });
        }
      }
      // EC25 detection (vendor ID 2c7c)
      else if (usbDevices.includes('2c7c:0125') || usbDevices.toLowerCase().includes('quectel')) {
        detected.modemType = 'ec25';
        // EC25: data=ttyUSB2, audio=ttyUSB1
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

      // Si pas détecté mais ports présents, suggérer selon le nombre de ports
      if (!detected.modemType && detected.ports.length >= 3) {
        // Généralement 5+ ports = SIM7600, 3-4 ports = EC25
        if (detected.ports.length >= 5) {
          detected.modemType = 'sim7600';
          detected.suggestedDataPort = '/dev/ttyUSB2';
          detected.suggestedAudioPort = '/dev/ttyUSB4';  // SIM7600: audio=USB4
          detected.modems.push({
            id: 'modem-1',
            type: 'SIM7600',
            dataPort: '/dev/ttyUSB2',
            audioPort: '/dev/ttyUSB4',  // SIM7600: audio=USB4, not USB1
          });
          if (detected.ports.length >= 10) {
            detected.modems.push({
              id: 'modem-2',
              type: 'SIM7600',
              dataPort: '/dev/ttyUSB7',
              audioPort: '/dev/ttyUSB9',  // Second modem: USB9, not USB6
            });
          }
        } else {
          detected.modemType = 'ec25';
          detected.suggestedDataPort = '/dev/ttyUSB2';
          detected.suggestedAudioPort = '/dev/ttyUSB1';  // EC25: audio=USB1
        }
      }
    } catch (error) {
      detected.error = error.message;
    }

    return detected;
  }

  /**
   * Récupère l'IMSI du modem (nécessaire pour config chan_quectel)
   */
  async getModemImsi(dataPort = null) {
    const port = dataPort || this.modemConfig.dataPort || '/dev/ttyUSB2';

    try {
      // Via Asterisk si disponible
      const modemId = this.modemConfig.modemName || 'hni-modem';
      const result = await this.asteriskCmd(`quectel cmd ${modemId} AT+CIMI`);
      if (result && result.match(/\d{15}/)) {
        const imsi = result.match(/(\d{15})/)[1];
        this.logger.info(`[ModemService] IMSI via Asterisk: ${imsi}`);
        return imsi;
      }
    } catch (e) {
      // Fallback: accès direct
    }

    try {
      const result = await this.runCmd(`echo -e 'AT+CIMI\\r' | timeout 3 socat - ${port},raw,echo=0,b115200,crnl 2>/dev/null`);
      if (result && result.match(/\d{15}/)) {
        const imsi = result.match(/(\d{15})/)[1];
        this.logger.info(`[ModemService] IMSI via direct: ${imsi}`);
        return imsi;
      }
    } catch (e) {
      this.logger.warn(`[ModemService] Failed to get IMSI: ${e.message}`);
    }

    return null;
  }

  /**
   * Vérifie l'état du PIN SIM
   * Priorité: Asterisk (si modem initialisé) > accès direct (si modem non initialisé)
   */
  async checkSimPin(modemId) {
    try {
      // Si pas de modemId fourni, essayer de le récupérer depuis la config
      const effectiveModemId = modemId || this.modemConfig.modemName;

      // D'abord essayer via Asterisk (fonctionne si modem initialisé)
      if (effectiveModemId) {
        const result = await this.asteriskCmd(`quectel cmd ${effectiveModemId} AT+CPIN?`);
        // Si résultat valide (contient une réponse PIN), l'utiliser
        if (result && !result.includes('Error') && !result.includes('not found') &&
            (result.includes('READY') || result.includes('PIN') || result.includes('PUK'))) {
          this.logger.info(`[ModemService] PIN check via Asterisk: ${result}`);
          return this.parseSimPinStatus(result);
        }
      }

      // Sinon, essayer l'accès direct au port (pour modems non initialisés)
      // Note: cela peut échouer si Asterisk a le port ouvert
      const port = this.modemConfig.dataPort;
      if (!port || !fs.existsSync(port)) {
        return { status: 'no_modem', message: 'Aucun modem détecté' };
      }

      // Envoyer AT+CPIN? via le port série directement
      const result = await this.sendDirectAtCommand(port, 'AT+CPIN?', 5000);

      // Si erreur de commande (port occupé par Asterisk), indiquer que le modem est probablement OK
      if (result.includes('Error: Command failed')) {
        // Le port est probablement utilisé par Asterisk = modem initialisé = PIN OK
        return { status: 'ready', message: 'Modem initialisé (PIN déjà entré)', needsPin: false };
      }

      this.logger.info(`[ModemService] Direct PIN check result: ${result}`);
      return this.parseSimPinStatus(result);
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  }

  /**
   * Parse le résultat de AT+CPIN?
   */
  parseSimPinStatus(result) {
    if (result.includes('READY')) {
      return { status: 'ready', message: 'SIM déverrouillée', needsPin: false };
    }
    if (result.includes('SIM PIN')) {
      return { status: 'pin_required', message: 'Code PIN requis', needsPin: true };
    }
    if (result.includes('SIM PUK')) {
      return { status: 'puk_required', message: 'Code PUK requis (SIM bloquée)', needsPin: false };
    }
    if (result.includes('ERROR') || result.includes('NO SIM')) {
      return { status: 'no_sim', message: 'Aucune carte SIM détectée', needsPin: false };
    }
    return { status: 'unknown', message: result, needsPin: false };
  }

  /**
   * Récupère le nombre de tentatives PIN restantes
   */
  getPinAttemptsRemaining() {
    return {
      attemptsUsed: pinAttempts,
      attemptsRemaining: MAX_PIN_ATTEMPTS - pinAttempts,
      isLocked: pinLocked,
      maxAttempts: MAX_PIN_ATTEMPTS,
    };
  }

  /**
   * Réinitialise le compteur de tentatives PIN (admin only)
   */
  resetPinAttempts() {
    pinAttempts = 0;
    pinLocked = false;
    this.logger.info('[ModemService] PIN attempts counter reset');
    return { success: true, message: 'Compteur de tentatives réinitialisé' };
  }

  /**
   * Envoie une commande AT directement au port série et lit la réponse
   * Utilise socat avec timeout de lecture pour capturer la réponse du modem
   */
  async sendDirectAtCommand(port, command, timeoutMs = 5000) {
    return new Promise((resolve) => {
      // Utiliser socat avec le mode bidirectionnel et timeout de lecture (-t2)
      // Le subshell envoie la commande, attend, puis lit la réponse
      const script = `
        (
          echo -e '${command}\\r'
          sleep 1
        ) | timeout ${Math.floor(timeoutMs / 1000)} socat -t2 - ${port},raw,echo=0,b115200,crnl 2>/dev/null
      `;

      exec(script.trim(), { timeout: timeoutMs + 2000 }, (error, stdout, stderr) => {
        // Nettoyer la sortie (enlever les caractères de contrôle)
        const cleaned = (stdout || '').replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, '').trim();

        // Si on a de la sortie, c'est bon même si exit code non-zero (timeout)
        if (cleaned) {
          resolve(cleaned);
        } else if (error) {
          resolve(`Error: ${error.message}`);
        } else {
          resolve('');
        }
      });
    });
  }

  /**
   * Entre le code PIN SIM
   * TOUJOURS utilise l'accès direct au port car Asterisk ne peut pas
   * communiquer avec un modem non initialisé
   */
  async enterSimPin(pin, modemId) {
    // Vérifier si verrouillé
    if (pinLocked) {
      throw new Error('Trop de tentatives échouées. Réinitialisez le compteur ou utilisez le code PUK.');
    }

    if (!pin || !/^\d{4,8}$/.test(pin)) {
      throw new Error('Code PIN invalide (doit être 4-8 chiffres)');
    }

    const port = this.modemConfig.dataPort || '/dev/ttyUSB2';

    try {
      // Toujours utiliser l'accès direct au port pour le PIN
      // car Asterisk ne peut pas communiquer avec un modem non initialisé
      if (!fs.existsSync(port)) {
        throw new Error(`Port modem non trouvé: ${port}`);
      }

      this.logger.info(`[ModemService] Entering PIN via direct port access: ${port}`);

      // D'abord, vérifier l'état actuel du PIN
      const preCheck = await this.sendDirectAtCommand(port, 'AT+CPIN?', 5000);
      this.logger.info(`[ModemService] Pre-PIN check: ${preCheck}`);

      // Si déjà READY, pas besoin de PIN
      if (preCheck.includes('READY')) {
        this.logger.info('[ModemService] SIM already unlocked');
        pinAttempts = 0;
        this.saveModemConfig({ pinCode: pin });
        return { success: true, message: 'La carte SIM est déjà déverrouillée.' };
      }

      // Si pas besoin de PIN (autre erreur), signaler
      if (!preCheck.includes('SIM PIN') && preCheck.includes('ERROR')) {
        throw new Error(`Erreur modem: ${preCheck}`);
      }

      // Envoyer la commande PIN
      const result = await this.sendDirectAtCommand(port, `AT+CPIN="${pin}"`, 7000);
      this.logger.info(`[ModemService] PIN command result: ${result}`);

      // Attendre un peu que le modem traite
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Vérifier le nouvel état du PIN
      const postCheck = await this.sendDirectAtCommand(port, 'AT+CPIN?', 5000);
      this.logger.info(`[ModemService] Post-PIN check: ${postCheck}`);

      // Analyser les résultats
      const isSuccess = postCheck.includes('READY') ||
                        result.includes('OK') && !result.includes('ERROR');
      const isError = result.includes('CME ERROR') ||
                      result.includes('incorrect') ||
                      (postCheck.includes('SIM PIN') && !postCheck.includes('READY'));

      if (isSuccess) {
        // Succès - réinitialiser le compteur et sauvegarder
        pinAttempts = 0;
        this.saveModemConfig({ pinCode: pin });
        this.logger.info('[ModemService] SIM PIN entered successfully');

        // Recharger chan_quectel pour que Asterisk détecte le modem
        setTimeout(async () => {
          try {
            await this.asteriskCmd('module reload chan_quectel');
            this.logger.info('[ModemService] chan_quectel reloaded after PIN entry');
          } catch (e) {
            this.logger.warn('[ModemService] Failed to reload chan_quectel:', e.message);
          }
        }, 2000);

        return { success: true, message: 'Code PIN accepté! La carte SIM est déverrouillée. Le modem redémarre...' };
      }

      if (isError) {
        // Incrémenter le compteur d'échecs
        pinAttempts++;

        if (pinAttempts >= MAX_PIN_ATTEMPTS) {
          pinLocked = true;
          this.logger.error('[ModemService] PIN attempts exhausted - locking further attempts');
          throw new Error(`Code PIN incorrect. ATTENTION: Limite de ${MAX_PIN_ATTEMPTS} tentatives atteinte. Pour protéger votre carte SIM, les tentatives sont bloquées. Contactez l'administrateur.`);
        }

        const remaining = MAX_PIN_ATTEMPTS - pinAttempts;
        throw new Error(`Code PIN incorrect. Il vous reste ${remaining} tentative(s) avant blocage dans l'interface.`);
      }

      // Résultat ambigu mais probablement OK si pas d'erreur explicite
      if (postCheck.includes('READY')) {
        pinAttempts = 0;
        this.saveModemConfig({ pinCode: pin });
        return { success: true, message: 'Code PIN accepté! SIM déverrouillée.' };
      }

      return {
        success: false,
        message: 'Résultat incertain. Vérifiez l\'état du modem.',
        details: { result, postCheck }
      };
    } catch (error) {
      this.logger.error('[ModemService] Failed to enter SIM PIN:', error);
      throw error;
    }
  }

  /**
   * Génère le fichier quectel.conf pour Asterisk
   */
  generateQuectelConf(config = {}) {
    const mergedConfig = { ...this.modemConfig, ...config };
    const profile = MODEM_PROFILES[mergedConfig.modemType] || MODEM_PROFILES.ec25;
    const smsConfig = mergedConfig.sms || {};

    const modemName = mergedConfig.modemName || 'hni-modem';
    const dataPort = mergedConfig.dataPort || '/dev/ttyUSB2';
    // Default audio port depends on modem type: SIM7600=USB4, EC25=USB1
    const defaultAudioPort = profile.name === 'SIM7600' ? '/dev/ttyUSB4' : '/dev/ttyUSB1';
    const audioPort = mergedConfig.audioPort || defaultAudioPort;

    // Mapping stockage SMS: sqlite/modem -> 'me', sim -> 'sm'
    const msgStorage = smsConfig.storage === 'sim' ? 'sm' : 'me';
    const autoDeleteSms = smsConfig.autoDelete !== false ? 'yes' : 'no';

    // Configuration basée sur VM500 (production fonctionnelle)
    const confContent = `; Homenichat - Configuration chan_quectel
; Généré automatiquement - ${new Date().toISOString()}
; Type de modem: ${profile.name}
; Basé sur config VM500 production

[general]
interval=15
smsdb=/var/lib/asterisk/smsdb
csmsttl=600

[defaults]
context=from-gsm
group=0
rxgain=3
txgain=3
autodeletesms=${autoDeleteSms}
resetquectel=yes
msg_storage=${msgStorage}
msg_direct=off
usecallingpres=yes
callingpres=allowed_passed_screen
dtmf=relaxed

[${modemName}]
data=${dataPort}
audio=${audioPort}
slin16=${profile.slin16 ? 'yes' : 'no'}
${mergedConfig.imsi ? `imsi=${mergedConfig.imsi}` : '; imsi sera détecté automatiquement'}
${mergedConfig.phoneNumber ? `exten=+${mergedConfig.phoneNumber.replace(/^\+/, '')}` : ''}
`;

    return confContent;
  }

  /**
   * Applique la configuration quectel.conf
   */
  async applyQuectelConf(config = {}) {
    try {
      // Créer le dossier smsdb si nécessaire
      const smsdbPath = '/var/lib/asterisk/smsdb';
      await this.runCmd(`mkdir -p ${smsdbPath} && chown asterisk:asterisk ${smsdbPath} 2>/dev/null || true`);

      // Récupérer l'IMSI si pas fourni
      let configWithImsi = { ...config };
      if (!configWithImsi.imsi && !this.modemConfig.imsi) {
        this.logger.info('[ModemService] Detecting IMSI...');
        const imsi = await this.getModemImsi(configWithImsi.dataPort);
        if (imsi) {
          configWithImsi.imsi = imsi;
          this.logger.info(`[ModemService] IMSI detected: ${imsi}`);
        }
      }

      const confContent = this.generateQuectelConf(configWithImsi);

      // Écrire le fichier
      fs.writeFileSync(QUECTEL_CONF_PATH, confContent);
      this.logger.info('[ModemService] quectel.conf written');

      // Sauvegarder la config avec IMSI
      this.saveModemConfig(configWithImsi);

      // Recharger Asterisk
      const reloadResult = await this.asteriskCmd('module reload chan_quectel');

      // Si PIN configuré, l'envoyer
      if (this.modemConfig.pinCode) {
        await new Promise(resolve => setTimeout(resolve, 3000)); // Attendre que le modem soit prêt
        const pinStatus = await this.checkSimPin();
        if (pinStatus.needsPin) {
          await this.enterSimPin(this.modemConfig.pinCode);
        }
      }

      return {
        success: true,
        message: 'Configuration appliquée',
        confPath: QUECTEL_CONF_PATH,
        imsi: configWithImsi.imsi,
        reloadResult,
      };
    } catch (error) {
      this.logger.error('[ModemService] Failed to apply quectel.conf:', error);
      throw error;
    }
  }

  /**
   * Lit le fichier quectel.conf actuel
   */
  readQuectelConf() {
    try {
      if (fs.existsSync(QUECTEL_CONF_PATH)) {
        return fs.readFileSync(QUECTEL_CONF_PATH, 'utf8');
      }
      return null;
    } catch (error) {
      this.logger.error('[ModemService] Error reading quectel.conf:', error);
      return null;
    }
  }

  /**
   * Configure l'audio selon le type de modem
   */
  async configureAudioForType(modemId, modemType = null) {
    const type = modemType || this.modemConfig.modemType || 'ec25';
    const profile = MODEM_PROFILES[type];

    if (!profile) {
      throw new Error(`Type de modem inconnu: ${type}`);
    }

    const results = {};
    for (const cmd of profile.audioCommands) {
      try {
        results[cmd] = await this.asteriskCmd(`quectel cmd ${modemId} ${cmd}`);
      } catch (e) {
        results[cmd] = `Error: ${e.message}`;
      }
    }

    this.logger.info(`[ModemService] Audio configured for ${profile.name}`);
    return { success: true, modem: modemId, modemType: type, profile: profile.name, results };
  }

  /**
   * Initialise le modem (PIN + audio)
   */
  async initializeModem(modemId = null) {
    const results = {
      pinStatus: null,
      pinEntered: false,
      audioConfigured: false,
    };

    try {
      // 1. Vérifier/entrer le PIN
      const pinStatus = await this.checkSimPin(modemId);
      results.pinStatus = pinStatus;

      if (pinStatus.needsPin && this.modemConfig.pinCode) {
        const pinResult = await this.enterSimPin(this.modemConfig.pinCode, modemId);
        results.pinEntered = pinResult.success;
      }

      // 2. Configurer l'audio
      if (modemId) {
        const audioResult = await this.configureAudioForType(modemId);
        results.audioConfigured = audioResult.success;
      }

      return { success: true, ...results };
    } catch (error) {
      this.logger.error('[ModemService] Failed to initialize modem:', error);
      return { success: false, error: error.message, ...results };
    }
  }
}

module.exports = ModemService;
module.exports.MODEM_PROFILES = MODEM_PROFILES;
