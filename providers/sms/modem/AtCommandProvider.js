/**
 * AtCommandProvider - Communication directe via commandes AT
 *
 * Permet de contrôler un modem GSM (SIM7600, EC25, etc.) directement
 * via les commandes AT sans passer par Gammu.
 *
 * Fonctionnalités:
 * - Envoi/réception SMS
 * - Lecture signal et opérateur
 * - Gestion SIM (PIN, état)
 * - Mode PDU et texte
 */

const EventEmitter = require('events');

class AtCommandProvider extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      device: config.device || '/dev/ttyUSB2',
      baudRate: config.baudRate || 115200,
      pin: config.pin || null,
      smsc: config.smsc || null,  // Centre SMS
      timeout: config.timeout || 10000,
      useTextMode: config.useTextMode !== false,  // Mode texte par défaut
    };

    this.port = null;
    this.isReady = false;
    this.commandQueue = [];
    this.currentCommand = null;
    this.responseBuffer = '';
    this.modemInfo = {};
  }

  /**
   * Initialise la connexion au modem
   */
  async initialize() {
    try {
      const { SerialPort } = require('serialport');

      this.port = new SerialPort({
        path: this.config.device,
        baudRate: this.config.baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        autoOpen: false,
      });

      return new Promise((resolve, reject) => {
        this.port.on('error', (err) => {
          console.error('Serial port error:', err);
          this.emit('error', err);
        });

        this.port.on('data', (data) => {
          this.handleData(data);
        });

        this.port.on('close', () => {
          this.isReady = false;
          this.emit('disconnected');
        });

        this.port.open(async (err) => {
          if (err) {
            reject(err);
            return;
          }

          try {
            // Séquence d'initialisation
            await this.initSequence();
            this.isReady = true;
            this.emit('ready', this.modemInfo);
            resolve(this.modemInfo);
          } catch (initErr) {
            reject(initErr);
          }
        });
      });
    } catch (error) {
      throw new Error(`SerialPort module required: ${error.message}`);
    }
  }

  /**
   * Séquence d'initialisation du modem
   */
  async initSequence() {
    // Test de base
    await this.sendCommand('AT');

    // Désactiver l'echo
    await this.sendCommand('ATE0');

    // Vérifier l'état de la SIM
    const simStatus = await this.sendCommand('AT+CPIN?');
    if (simStatus.includes('SIM PIN') && this.config.pin) {
      await this.sendCommand(`AT+CPIN=${this.config.pin}`);
      await this.delay(2000);
    }

    // Attendre l'enregistrement réseau
    await this.waitForNetwork();

    // Mode texte pour SMS (plus simple)
    if (this.config.useTextMode) {
      await this.sendCommand('AT+CMGF=1');
    }

    // Configurer les notifications SMS
    await this.sendCommand('AT+CNMI=2,1,0,0,0');

    // Récupérer les infos du modem
    this.modemInfo = await this.getModemInfo();

    return this.modemInfo;
  }

  /**
   * Attend l'enregistrement sur le réseau
   */
  async waitForNetwork(maxAttempts = 30) {
    for (let i = 0; i < maxAttempts; i++) {
      const response = await this.sendCommand('AT+CREG?');

      // +CREG: 0,1 (home) ou +CREG: 0,5 (roaming)
      if (response.includes(',1') || response.includes(',5')) {
        return true;
      }

      await this.delay(1000);
    }

    throw new Error('Network registration timeout');
  }

  /**
   * Récupère les informations du modem
   */
  async getModemInfo() {
    const info = {};

    try {
      // Fabricant
      const manufacturer = await this.sendCommand('AT+CGMI');
      info.manufacturer = this.parseResponse(manufacturer);

      // Modèle
      const model = await this.sendCommand('AT+CGMM');
      info.model = this.parseResponse(model);

      // IMEI
      const imei = await this.sendCommand('AT+CGSN');
      info.imei = this.parseResponse(imei);

      // Numéro de téléphone (si disponible)
      try {
        const num = await this.sendCommand('AT+CNUM');
        const match = num.match(/\+CNUM:.*"([^"]+)"/);
        info.phone = match ? match[1] : null;
      } catch (e) {
        info.phone = null;
      }

      // Opérateur
      const operator = await this.sendCommand('AT+COPS?');
      const opMatch = operator.match(/\+COPS:.*"([^"]+)"/);
      info.operator = opMatch ? opMatch[1] : null;

      // Signal
      const signal = await this.sendCommand('AT+CSQ');
      const sigMatch = signal.match(/\+CSQ:\s*(\d+)/);
      if (sigMatch) {
        const rssi = parseInt(sigMatch[1], 10);
        // Convertir RSSI en pourcentage (0-31 -> 0-100)
        info.signal = rssi === 99 ? 0 : Math.round((rssi / 31) * 100);
      }
    } catch (error) {
      console.error('Error getting modem info:', error);
    }

    return info;
  }

  /**
   * Envoie un SMS
   */
  async sendSms(to, message) {
    if (!this.isReady) {
      throw new Error('Modem not ready');
    }

    // Normaliser le numéro
    const phoneNumber = this.normalizePhoneNumber(to);

    if (this.config.useTextMode) {
      return this.sendSmsText(phoneNumber, message);
    } else {
      return this.sendSmsPdu(phoneNumber, message);
    }
  }

  /**
   * Envoie un SMS en mode texte
   */
  async sendSmsText(to, message) {
    // Configurer le centre SMS si spécifié
    if (this.config.smsc) {
      await this.sendCommand(`AT+CSCA="${this.config.smsc}"`);
    }

    // Commande d'envoi SMS
    await this.sendCommand(`AT+CMGS="${to}"`, {
      waitFor: '>',
      timeout: 5000,
    });

    // Envoyer le message + Ctrl+Z
    const response = await this.sendCommand(`${message}\x1A`, {
      timeout: 30000,  // SMS peut prendre du temps
    });

    // Vérifier le résultat
    if (response.includes('+CMGS:')) {
      const match = response.match(/\+CMGS:\s*(\d+)/);
      return {
        success: true,
        messageRef: match ? match[1] : null,
      };
    }

    throw new Error('SMS sending failed: ' + response);
  }

  /**
   * Envoie un SMS en mode PDU (pour support Unicode, etc.)
   */
  async sendSmsPdu(to, message) {
    // TODO: Implémenter l'encodage PDU si nécessaire
    throw new Error('PDU mode not yet implemented');
  }

  /**
   * Lit les SMS reçus
   */
  async readSms(status = 'ALL') {
    if (!this.isReady) {
      throw new Error('Modem not ready');
    }

    // Status: REC UNREAD, REC READ, STO UNSENT, STO SENT, ALL
    const response = await this.sendCommand(`AT+CMGL="${status}"`, {
      timeout: 10000,
    });

    return this.parseSmsListResponse(response);
  }

  /**
   * Supprime un SMS
   */
  async deleteSms(index) {
    await this.sendCommand(`AT+CMGD=${index}`);
    return true;
  }

  /**
   * Supprime tous les SMS lus
   */
  async deleteAllReadSms() {
    await this.sendCommand('AT+CMGD=1,1');
    return true;
  }

  /**
   * Récupère la force du signal
   */
  async getSignalStrength() {
    const response = await this.sendCommand('AT+CSQ');
    const match = response.match(/\+CSQ:\s*(\d+)/);

    if (match) {
      const rssi = parseInt(match[1], 10);
      return {
        rssi,
        percent: rssi === 99 ? 0 : Math.round((rssi / 31) * 100),
        dbm: rssi === 99 ? null : -113 + (rssi * 2),
      };
    }

    return null;
  }

  /**
   * Récupère les infos réseau
   */
  async getNetworkInfo() {
    const info = {};

    // Opérateur
    const cops = await this.sendCommand('AT+COPS?');
    const copsMatch = cops.match(/\+COPS:\s*\d+,\d+,"([^"]+)",(\d+)/);
    if (copsMatch) {
      info.operator = copsMatch[1];
      info.technology = this.parseTechnology(copsMatch[2]);
    }

    // Statut enregistrement
    const creg = await this.sendCommand('AT+CREG?');
    const cregMatch = creg.match(/\+CREG:\s*\d+,(\d+)/);
    if (cregMatch) {
      info.registered = ['1', '5'].includes(cregMatch[1]);
      info.roaming = cregMatch[1] === '5';
    }

    return info;
  }

  /**
   * Envoie une commande AT et attend la réponse
   */
  sendCommand(command, options = {}) {
    return new Promise((resolve, reject) => {
      const timeout = options.timeout || this.config.timeout;
      const waitFor = options.waitFor || 'OK';

      const cmd = {
        command,
        resolve,
        reject,
        waitFor,
        buffer: '',
        timer: setTimeout(() => {
          cmd.reject(new Error(`Command timeout: ${command}`));
          this.currentCommand = null;
          this.processQueue();
        }, timeout),
      };

      this.commandQueue.push(cmd);

      if (!this.currentCommand) {
        this.processQueue();
      }
    });
  }

  /**
   * Traite la file de commandes
   */
  processQueue() {
    if (this.commandQueue.length === 0) {
      return;
    }

    this.currentCommand = this.commandQueue.shift();
    this.responseBuffer = '';

    // Envoyer la commande
    this.port.write(this.currentCommand.command + '\r\n');
  }

  /**
   * Traite les données reçues du modem
   */
  handleData(data) {
    const text = data.toString();
    this.responseBuffer += text;

    // Émettre les données brutes
    this.emit('data', text);

    // Vérifier les notifications SMS entrantes
    if (this.responseBuffer.includes('+CMTI:')) {
      const match = this.responseBuffer.match(/\+CMTI:\s*"([^"]+)",(\d+)/);
      if (match) {
        this.emit('sms_received', {
          memory: match[1],
          index: parseInt(match[2], 10),
        });
      }
    }

    // Si une commande est en cours, vérifier la réponse
    if (this.currentCommand) {
      const waitFor = this.currentCommand.waitFor;

      if (this.responseBuffer.includes(waitFor) ||
          this.responseBuffer.includes('ERROR') ||
          this.responseBuffer.includes('+CME ERROR') ||
          this.responseBuffer.includes('+CMS ERROR')) {

        clearTimeout(this.currentCommand.timer);

        if (this.responseBuffer.includes('ERROR')) {
          this.currentCommand.reject(new Error(this.responseBuffer.trim()));
        } else {
          this.currentCommand.resolve(this.responseBuffer.trim());
        }

        this.currentCommand = null;
        this.processQueue();
      }
    }
  }

  /**
   * Parse la réponse pour extraire la valeur
   */
  parseResponse(response) {
    // Enlever OK et les lignes vides
    return response
      .split('\n')
      .filter(line => line.trim() && !line.includes('OK') && !line.startsWith('AT'))
      .join('\n')
      .trim();
  }

  /**
   * Parse la liste des SMS
   */
  parseSmsListResponse(response) {
    const messages = [];
    const lines = response.split('\n');

    let currentMessage = null;

    for (const line of lines) {
      // +CMGL: index,"status","from",...
      const match = line.match(/\+CMGL:\s*(\d+),"([^"]+)","([^"]+)".*"([^"]+)"/);

      if (match) {
        if (currentMessage) {
          messages.push(currentMessage);
        }

        currentMessage = {
          index: parseInt(match[1], 10),
          status: match[2],
          from: match[3],
          timestamp: match[4],
          message: '',
        };
      } else if (currentMessage && line.trim() && !line.includes('OK')) {
        currentMessage.message += line.trim();
      }
    }

    if (currentMessage) {
      messages.push(currentMessage);
    }

    return messages;
  }

  /**
   * Normalise un numéro de téléphone
   */
  normalizePhoneNumber(number) {
    // Supprimer les espaces et caractères spéciaux
    let normalized = number.replace(/[\s\-\(\)\.]/g, '');

    // S'assurer que le numéro commence par +
    if (!normalized.startsWith('+')) {
      // Si commence par 00, remplacer par +
      if (normalized.startsWith('00')) {
        normalized = '+' + normalized.substring(2);
      } else if (normalized.startsWith('0')) {
        // Numéro local français, ajouter +33
        normalized = '+33' + normalized.substring(1);
      }
    }

    return normalized;
  }

  /**
   * Parse le type de technologie réseau
   */
  parseTechnology(code) {
    const techs = {
      '0': 'GSM',
      '1': 'GSM Compact',
      '2': 'UTRAN (3G)',
      '3': 'GSM EDGE',
      '4': 'UTRAN HSDPA',
      '5': 'UTRAN HSUPA',
      '6': 'UTRAN HSPA',
      '7': 'E-UTRAN (LTE)',
    };
    return techs[code] || 'Unknown';
  }

  /**
   * Utilitaire de délai
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Ferme la connexion
   */
  async close() {
    if (this.port && this.port.isOpen) {
      return new Promise((resolve) => {
        this.port.close(() => {
          this.isReady = false;
          resolve();
        });
      });
    }
  }

  /**
   * Status du provider
   */
  getStatus() {
    return {
      isReady: this.isReady,
      device: this.config.device,
      ...this.modemInfo,
    };
  }
}

module.exports = AtCommandProvider;
