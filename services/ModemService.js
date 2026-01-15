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
      'AT+CPCMFRM=0',     // 8kHz PCM format
      'AT+CMICGAIN=0',
      'AT+COUTGAIN=5',
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
        return JSON.parse(data);
      }
    } catch (error) {
      this.logger.error('[ModemService] Error loading modem config:', error);
    }

    // Configuration par défaut
    return {
      modemType: 'ec25',
      modemName: 'homenichat-modem',
      phoneNumber: '',
      pinCode: '',
      dataPort: '/dev/ttyUSB2',
      audioPort: '/dev/ttyUSB1',
      autoDetect: true,
    };
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
    };

    try {
      // Lister tous les ports ttyUSB
      const result = await this.runCmd('ls /dev/ttyUSB* 2>/dev/null');
      if (result && !result.startsWith('Error') && !result.includes('No such file')) {
        detected.ports = result.split('\n').filter(p => p.trim()).map(p => p.trim());
      }

      // Chercher des indices sur le type de modem via USB vendor/product
      const usbDevices = await this.runCmd('lsusb 2>/dev/null');

      if (usbDevices.toLowerCase().includes('quectel')) {
        detected.modemType = 'ec25';
        // EC25: data=ttyUSB2, audio=ttyUSB1
        if (detected.ports.includes('/dev/ttyUSB2')) {
          detected.suggestedDataPort = '/dev/ttyUSB2';
        }
        if (detected.ports.includes('/dev/ttyUSB1')) {
          detected.suggestedAudioPort = '/dev/ttyUSB1';
        }
      } else if (usbDevices.toLowerCase().includes('simcom') ||
                 usbDevices.toLowerCase().includes('sim7600')) {
        detected.modemType = 'sim7600';
        // SIM7600: data=ttyUSB3, audio=ttyUSB2
        if (detected.ports.includes('/dev/ttyUSB3')) {
          detected.suggestedDataPort = '/dev/ttyUSB3';
        }
        if (detected.ports.includes('/dev/ttyUSB2')) {
          detected.suggestedAudioPort = '/dev/ttyUSB2';
        }
      }

      // Si pas détecté mais ports présents, suggérer selon le nombre de ports
      if (!detected.modemType && detected.ports.length >= 3) {
        // Généralement 5 ports = SIM7600, 3-4 ports = EC25
        if (detected.ports.length >= 5) {
          detected.modemType = 'sim7600';
          detected.suggestedDataPort = '/dev/ttyUSB3';
          detected.suggestedAudioPort = '/dev/ttyUSB2';
        } else {
          detected.modemType = 'ec25';
          detected.suggestedDataPort = '/dev/ttyUSB2';
          detected.suggestedAudioPort = '/dev/ttyUSB1';
        }
      }

      // Vérifier quel port répond aux commandes AT
      for (const port of detected.ports) {
        try {
          // Test rapide avec timeout court
          const testResult = await this.runCmd(`echo "AT" | timeout 2 cat > ${port} && timeout 2 cat < ${port} 2>/dev/null`, 5000);
          if (testResult.includes('OK')) {
            detected.suggestedDataPort = port;
            break;
          }
        } catch (e) {
          // Ignorer les erreurs de test
        }
      }
    } catch (error) {
      detected.error = error.message;
    }

    return detected;
  }

  /**
   * Vérifie l'état du PIN SIM
   */
  async checkSimPin(modemId) {
    try {
      // D'abord essayer via Asterisk si modem configuré
      if (modemId) {
        const result = await this.asteriskCmd(`quectel cmd ${modemId} AT+CPIN?`);
        return this.parseSimPinStatus(result);
      }

      // Sinon, utiliser le port configuré directement
      const port = this.modemConfig.dataPort;
      if (!port || !fs.existsSync(port)) {
        return { status: 'no_modem', message: 'Aucun modem détecté' };
      }

      // Envoyer AT+CPIN? via le port
      const result = await this.runCmd(`echo "AT+CPIN?" | timeout 3 socat - ${port},raw,echo=0,b115200 2>/dev/null`, 5000);
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
   * Entre le code PIN SIM
   */
  async enterSimPin(pin, modemId) {
    if (!pin || !/^\d{4,8}$/.test(pin)) {
      throw new Error('Code PIN invalide (doit être 4-8 chiffres)');
    }

    try {
      let result;

      if (modemId) {
        // Via Asterisk
        result = await this.asteriskCmd(`quectel cmd ${modemId} AT+CPIN="${pin}"`);
      } else {
        // Via port direct
        const port = this.modemConfig.dataPort;
        if (!port || !fs.existsSync(port)) {
          throw new Error('Aucun modem détecté');
        }
        result = await this.runCmd(`echo 'AT+CPIN="${pin}"' | timeout 5 socat - ${port},raw,echo=0,b115200 2>/dev/null`, 7000);
      }

      // Vérifier le résultat
      if (result.includes('OK')) {
        // Sauvegarder le PIN pour les prochains démarrages
        this.saveModemConfig({ pinCode: pin });
        this.logger.info('[ModemService] SIM PIN entered successfully');
        return { success: true, message: 'Code PIN accepté' };
      }

      if (result.includes('ERROR')) {
        // Vérifier le nombre de tentatives restantes
        const attemptsMatch = result.match(/(\d+) retries/i);
        const remaining = attemptsMatch ? attemptsMatch[1] : 'inconnu';
        throw new Error(`Code PIN incorrect. Tentatives restantes: ${remaining}`);
      }

      return { success: true, message: 'Commande envoyée', result };
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

    const modemName = mergedConfig.modemName || 'homenichat-modem';
    const dataPort = mergedConfig.dataPort || '/dev/ttyUSB2';
    const audioPort = mergedConfig.audioPort || '/dev/ttyUSB1';

    const confContent = `; Homenichat - Configuration chan_quectel
; Généré automatiquement - ${new Date().toISOString()}
; Type de modem: ${profile.name}

[general]
; Intervalle d'interrogation du modem (ms)
rxgain=3
txgain=3

[${modemName}]
; Configuration du modem ${profile.name}
audio=${audioPort}
data=${dataPort}

; Audio format (${profile.slin16 ? '16kHz' : '8kHz'})
slin16=${profile.slin16 ? 'yes' : 'no'}

; Stockage SMS sur modem
msg_storage=${profile.msg_storage}

; Délai avant réponse
autodeletesms=yes

; Contexte pour les appels entrants
context=from-gsm

; Numéro de téléphone (si connu)
${mergedConfig.phoneNumber ? `exten=+${mergedConfig.phoneNumber.replace(/^\+/, '')}` : '; exten=+NUMERO'}

; Groupe pour le routage
group=1
`;

    return confContent;
  }

  /**
   * Applique la configuration quectel.conf
   */
  async applyQuectelConf(config = {}) {
    try {
      const confContent = this.generateQuectelConf(config);

      // Écrire le fichier
      fs.writeFileSync(QUECTEL_CONF_PATH, confContent);
      this.logger.info('[ModemService] quectel.conf written');

      // Sauvegarder la config
      this.saveModemConfig(config);

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
