/**
 * GammuModemProvider - Communication via Gammu
 *
 * Utilise gammu-smsd pour l'envoi/réception de SMS.
 * Plus robuste que les commandes AT directes pour la gestion des SMS.
 *
 * Prérequis:
 * - gammu et gammu-smsd installés
 * - Configuration gammu (~/.gammurc ou /etc/gammu-smsdrc)
 */

const { exec, execSync, spawn } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

class GammuModemProvider extends EventEmitter {
  constructor(config = {}) {
    super();

    this.config = {
      device: config.device || '/dev/ttyUSB2',
      connection: config.connection || 'at',
      baudRate: config.baudRate || 115200,
      pin: config.pin || null,
      smsc: config.smsc || null,
      gammuPath: config.gammuPath || '/usr/bin/gammu',
      configFile: config.configFile || null,
      spoolDir: config.spoolDir || '/var/spool/gammu',
      useDaemon: config.useDaemon || false,
    };

    this.isReady = false;
    this.modemInfo = {};
    this.pollInterval = null;
  }

  /**
   * Initialise le provider
   */
  async initialize() {
    // Vérifier que gammu est installé
    if (!this.checkGammuInstalled()) {
      throw new Error('Gammu is not installed. Please install gammu package.');
    }

    // Créer le fichier de configuration temporaire si nécessaire
    if (!this.config.configFile) {
      this.config.configFile = this.createTempConfig();
    }

    // Tester la connexion au modem
    try {
      this.modemInfo = await this.identifyModem();
      this.isReady = true;
      this.emit('ready', this.modemInfo);

      // Démarrer le polling des SMS si demandé
      if (this.config.useDaemon) {
        this.startSmsPolling();
      }

      return this.modemInfo;
    } catch (error) {
      throw new Error(`Failed to initialize modem: ${error.message}`);
    }
  }

  /**
   * Vérifie que gammu est installé
   */
  checkGammuInstalled() {
    try {
      execSync(`${this.config.gammuPath} --version`, { encoding: 'utf8' });
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Crée un fichier de configuration temporaire
   */
  createTempConfig() {
    const configContent = `
[gammu]
device = ${this.config.device}
connection = ${this.config.connection}
${this.config.baudRate ? `speed = ${this.config.baudRate}` : ''}
${this.config.pin ? `PIN = ${this.config.pin}` : ''}
`;

    const configPath = path.join('/tmp', `gammu-${Date.now()}.conf`);
    fs.writeFileSync(configPath, configContent);

    return configPath;
  }

  /**
   * Exécute une commande gammu
   */
  execGammu(args) {
    return new Promise((resolve, reject) => {
      const cmd = `${this.config.gammuPath} -c "${this.config.configFile}" ${args}`;

      exec(cmd, { timeout: 30000, encoding: 'utf8' }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Identifie le modem
   */
  async identifyModem() {
    const output = await this.execGammu('--identify');

    const info = {};
    const lines = output.split('\n');

    for (const line of lines) {
      if (line.includes(':')) {
        const [key, value] = line.split(':').map(s => s.trim());
        const keyLower = key.toLowerCase();

        if (keyLower.includes('manufacturer')) {
          info.manufacturer = value;
        } else if (keyLower.includes('model')) {
          info.model = value;
        } else if (keyLower.includes('imei')) {
          info.imei = value;
        } else if (keyLower.includes('firmware')) {
          info.firmware = value;
        }
      }
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

    // Échapper le message pour la ligne de commande
    const escapedMessage = message.replace(/'/g, "'\\''");
    const escapedTo = to.replace(/'/g, "'\\''");

    try {
      // Méthode 1: Utiliser echo et pipe
      const result = await new Promise((resolve, reject) => {
        const proc = spawn(this.config.gammuPath, [
          '-c', this.config.configFile,
          'sendsms', 'TEXT', escapedTo,
        ], {
          timeout: 60000,
        });

        let stdout = '';
        let stderr = '';

        proc.stdin.write(message);
        proc.stdin.end();

        proc.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true, output: stdout });
          } else {
            reject(new Error(stderr || `Exit code: ${code}`));
          }
        });

        proc.on('error', (err) => {
          reject(err);
        });
      });

      // Parser le message reference si présent
      const match = result.output.match(/Reference=(\d+)/);

      return {
        success: true,
        messageRef: match ? match[1] : null,
        output: result.output,
      };
    } catch (error) {
      throw new Error(`SMS sending failed: ${error.message}`);
    }
  }

  /**
   * Lit tous les SMS
   */
  async readAllSms() {
    if (!this.isReady) {
      throw new Error('Modem not ready');
    }

    try {
      const output = await this.execGammu('--getallsms');
      return this.parseSmsOutput(output);
    } catch (error) {
      // Pas de SMS n'est pas une erreur
      if (error.message.includes('empty')) {
        return [];
      }
      throw error;
    }
  }

  /**
   * Parse la sortie de getallsms
   */
  parseSmsOutput(output) {
    const messages = [];
    const parts = output.split(/\n(?=Location\s+:)/);

    for (const part of parts) {
      if (!part.trim()) continue;

      const message = {};
      const lines = part.split('\n');

      for (const line of lines) {
        if (line.includes('Location')) {
          const match = line.match(/Location\s+:\s*(\d+)/);
          message.index = match ? parseInt(match[1], 10) : null;
        } else if (line.includes('Folder')) {
          message.folder = line.split(':')[1]?.trim();
        } else if (line.includes('Remote number')) {
          message.from = line.split(':')[1]?.trim().replace(/"/g, '');
        } else if (line.includes('Sent')) {
          message.timestamp = line.split(':', 2)[1]?.trim();
        } else if (line.includes('Status')) {
          message.status = line.split(':')[1]?.trim();
        } else if (!line.includes(':') && line.trim()) {
          message.message = (message.message || '') + line.trim() + '\n';
        }
      }

      if (message.index !== undefined) {
        message.message = message.message?.trim();
        messages.push(message);
      }
    }

    return messages;
  }

  /**
   * Supprime un SMS
   */
  async deleteSms(index, folder = 1) {
    await this.execGammu(`--deletesms ${folder} ${index}`);
    return true;
  }

  /**
   * Supprime tous les SMS
   */
  async deleteAllSms() {
    await this.execGammu('--deleteallsms 0');
    return true;
  }

  /**
   * Récupère la force du signal
   */
  async getSignalStrength() {
    try {
      const output = await this.execGammu('--networkinfo');
      const match = output.match(/Signal strength\s*:\s*(-?\d+)\s*%/);

      if (match) {
        return {
          percent: parseInt(match[1], 10),
        };
      }
    } catch (error) {
      console.error('Error getting signal:', error);
    }

    return null;
  }

  /**
   * Récupère les infos réseau
   */
  async getNetworkInfo() {
    try {
      const output = await this.execGammu('--networkinfo');
      const info = {};

      const lines = output.split('\n');
      for (const line of lines) {
        if (line.includes('Network name')) {
          info.operator = line.split(':')[1]?.trim().replace(/"/g, '');
        } else if (line.includes('LAC')) {
          const match = line.match(/LAC\s+(\w+)/);
          info.lac = match ? match[1] : null;
        } else if (line.includes('CID')) {
          const match = line.match(/CID\s+(\w+)/);
          info.cid = match ? match[1] : null;
        } else if (line.includes('GPRS')) {
          info.gprsAttached = line.toLowerCase().includes('attached');
        }
      }

      return info;
    } catch (error) {
      console.error('Error getting network info:', error);
      return {};
    }
  }

  /**
   * Récupère le niveau de batterie (si supporté)
   */
  async getBatteryLevel() {
    try {
      const output = await this.execGammu('--getbatteryinfo');
      const match = output.match(/Charge Level\s*:\s*(\d+)\s*%/);

      if (match) {
        return parseInt(match[1], 10);
      }
    } catch (error) {
      // La plupart des modems USB n'ont pas de batterie
    }

    return null;
  }

  /**
   * Démarre le polling des SMS entrants
   */
  startSmsPolling(intervalMs = 10000) {
    if (this.pollInterval) {
      return;
    }

    let lastChecked = new Set();

    this.pollInterval = setInterval(async () => {
      try {
        const messages = await this.readAllSms();
        const currentIds = new Set(messages.map(m => `${m.index}-${m.timestamp}`));

        // Trouver les nouveaux messages
        for (const msg of messages) {
          const id = `${msg.index}-${msg.timestamp}`;
          if (!lastChecked.has(id) && msg.status === 'UnRead') {
            this.emit('sms_received', msg);
          }
        }

        lastChecked = currentIds;
      } catch (error) {
        console.error('SMS polling error:', error);
      }
    }, intervalMs);
  }

  /**
   * Arrête le polling
   */
  stopSmsPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Retourne le statut du provider
   */
  getStatus() {
    return {
      isReady: this.isReady,
      device: this.config.device,
      connection: this.config.connection,
      ...this.modemInfo,
    };
  }

  /**
   * Ferme le provider
   */
  async close() {
    this.stopSmsPolling();

    // Supprimer le fichier de config temporaire
    if (this.config.configFile && this.config.configFile.startsWith('/tmp/')) {
      try {
        fs.unlinkSync(this.config.configFile);
      } catch (e) {
        // Ignore
      }
    }

    this.isReady = false;
  }
}

module.exports = GammuModemProvider;
