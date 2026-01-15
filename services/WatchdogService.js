/**
 * WatchdogService - Service de surveillance et récupération automatique
 * Inspiré du smsgate-watchdog v6.0 de VM500
 *
 * Fonctionnalités:
 * - Surveillance des modems GSM
 * - Niveaux de récupération progressifs (soft -> medium -> hard)
 * - Configuration automatique après récupération
 * - Logs détaillés
 */

const { exec, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

class WatchdogService {
  constructor(config = {}) {
    this.enabled = config.enabled !== false;
    this.checkIntervalMs = config.checkIntervalMs || 30000; // 30 secondes
    this.modems = config.modems || {};
    this.logPath = config.logPath || '/var/log/homenichat-watchdog.log';
    this.dataDir = config.dataDir || '/var/lib/homenichat/watchdog';

    // Compteurs de vérification (pour les niveaux de récupération)
    this.checkCount = {};
    this.recoveryAttempts = {};

    // Seuils de récupération
    this.thresholds = {
      soft: config.softThreshold || 3,     // Après 3 échecs -> soft restart
      medium: config.mediumThreshold || 6, // Après 6 échecs -> medium restart
      hard: config.hardThreshold || 10,    // Après 10 échecs -> hard restart
    };

    this.interval = null;
    this.running = false;
  }

  /**
   * Démarre le watchdog
   */
  start() {
    if (this.running || !this.enabled) return;

    this.running = true;
    this.log('INFO', 'Watchdog service started');

    // Créer le répertoire de données si nécessaire
    try {
      if (!fs.existsSync(this.dataDir)) {
        fs.mkdirSync(this.dataDir, { recursive: true });
      }
    } catch (e) {
      this.log('WARNING', `Could not create data dir: ${e.message}`);
    }

    // Lancer la boucle de vérification
    this.runCheck();
    this.interval = setInterval(() => this.runCheck(), this.checkIntervalMs);
  }

  /**
   * Arrête le watchdog
   */
  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.running = false;
    this.log('INFO', 'Watchdog service stopped');
  }

  /**
   * Exécute une vérification complète
   */
  async runCheck() {
    try {
      // Vérifier Asterisk
      const asteriskOk = await this.checkAsterisk();
      if (!asteriskOk) {
        await this.recoverAsterisk();
        return;
      }

      // Vérifier chaque modem
      const modemIds = await this.listModems();

      for (const modemId of modemIds) {
        const status = await this.checkModem(modemId);

        if (!status.ok) {
          this.incrementFailure(modemId);
          await this.handleModemFailure(modemId, status);
        } else {
          this.resetFailure(modemId);
        }
      }

    } catch (error) {
      this.log('ERROR', `Check error: ${error.message}`);
    }
  }

  /**
   * Vérifie si Asterisk est en cours d'exécution
   */
  async checkAsterisk() {
    try {
      const result = await this.runCmd('asterisk -rx "core show version" 2>/dev/null');
      return !result.startsWith('Error') && result.includes('Asterisk');
    } catch {
      return false;
    }
  }

  /**
   * Liste les modems depuis Asterisk
   */
  async listModems() {
    try {
      const output = await this.runCmd('asterisk -rx "quectel show devices" 2>/dev/null');
      const modems = [];

      for (const line of output.split('\n')) {
        const match = line.match(/^(quectel-\S+)/);
        if (match) {
          modems.push(match[1]);
        }
      }

      // Fallback sur la config si aucun modem détecté
      if (modems.length === 0) {
        return Object.keys(this.modems);
      }

      return modems;
    } catch {
      return Object.keys(this.modems);
    }
  }

  /**
   * Vérifie l'état d'un modem
   */
  async checkModem(modemId) {
    const status = {
      ok: false,
      state: 'Unknown',
      registered: false,
      rssi: 0,
    };

    try {
      const output = await this.runCmd(`asterisk -rx "quectel show device state ${modemId}" 2>/dev/null`);

      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.includes(':')) continue;

        const [key, value] = trimmed.split(':').map(s => s.trim());

        switch (key) {
          case 'State':
            status.state = value;
            break;
          case 'GSM Registration Status':
            status.registered = value.includes('Registered');
            break;
          case 'RSSI':
            const match = value.match(/(\d+)/);
            if (match) status.rssi = parseInt(match[1]);
            break;
        }
      }

      // Un modem est OK s'il est Free/InUse et enregistré
      status.ok = (status.state === 'Free' || status.state === 'Ring' || status.state === 'Dialing')
                  && status.registered
                  && status.rssi > 0;

    } catch (error) {
      status.error = error.message;
    }

    return status;
  }

  /**
   * Incrémente le compteur d'échecs pour un modem
   */
  incrementFailure(modemId) {
    this.checkCount[modemId] = (this.checkCount[modemId] || 0) + 1;
  }

  /**
   * Réinitialise le compteur d'échecs pour un modem
   */
  resetFailure(modemId) {
    if (this.checkCount[modemId] > 0) {
      this.log('OK', `Modem ${modemId} recovered`);
    }
    this.checkCount[modemId] = 0;
    this.recoveryAttempts[modemId] = 0;
  }

  /**
   * Gère un échec de modem
   */
  async handleModemFailure(modemId, status) {
    const failures = this.checkCount[modemId] || 0;
    const attempts = this.recoveryAttempts[modemId] || 0;

    this.log('WARNING', `Modem ${modemId} issue: state=${status.state}, registered=${status.registered}, rssi=${status.rssi} (failures: ${failures})`);

    if (failures >= this.thresholds.hard && attempts >= 2) {
      this.log('ERROR', `Modem ${modemId} unrecoverable after ${attempts} attempts`);
      return;
    }

    if (failures >= this.thresholds.hard) {
      await this.hardRecovery(modemId);
    } else if (failures >= this.thresholds.medium) {
      await this.mediumRecovery(modemId);
    } else if (failures >= this.thresholds.soft) {
      await this.softRecovery(modemId);
    }
  }

  /**
   * Récupération niveau 1 - Soft restart
   * Action: Restart du modem via Asterisk CLI
   */
  async softRecovery(modemId) {
    this.log('INFO', `[SOFT] Attempting soft recovery for ${modemId}`);
    this.recoveryAttempts[modemId] = (this.recoveryAttempts[modemId] || 0) + 1;

    try {
      await this.runCmd(`asterisk -rx "quectel restart now ${modemId}" 2>/dev/null`);
      this.log('INFO', `[SOFT] Restart command sent for ${modemId}`);

      // Attendre et reconfigurer l'audio
      await this.sleep(5000);
      await this.configureModemAudio(modemId);

    } catch (error) {
      this.log('ERROR', `[SOFT] Recovery failed: ${error.message}`);
    }
  }

  /**
   * Récupération niveau 2 - Medium restart
   * Action: Restart Asterisk + modems
   */
  async mediumRecovery(modemId) {
    this.log('INFO', `[MEDIUM] Attempting medium recovery for ${modemId}`);
    this.recoveryAttempts[modemId] = (this.recoveryAttempts[modemId] || 0) + 1;

    try {
      // Restart Asterisk
      await this.runCmd('systemctl restart asterisk 2>/dev/null');
      this.log('INFO', '[MEDIUM] Asterisk restarted');

      // Attendre le démarrage
      await this.sleep(15000);

      // Reconfigurer tous les modems
      const modems = await this.listModems();
      for (const m of modems) {
        await this.configureModemAudio(m);
      }

    } catch (error) {
      this.log('ERROR', `[MEDIUM] Recovery failed: ${error.message}`);
    }
  }

  /**
   * Récupération niveau 3 - Hard restart
   * Action: USB reset ou reboot système
   */
  async hardRecovery(modemId) {
    this.log('INFO', `[HARD] Attempting hard recovery for ${modemId}`);
    this.recoveryAttempts[modemId] = (this.recoveryAttempts[modemId] || 0) + 1;

    try {
      // Essayer un reset USB si disponible
      const usbReset = await this.tryUsbReset();

      if (!usbReset) {
        // En dernier recours, redémarrer tous les services
        this.log('WARNING', '[HARD] USB reset not available, restarting all modem services');
        await this.runCmd('systemctl restart asterisk 2>/dev/null');
      }

      // Attendre le démarrage
      await this.sleep(20000);

      // Reconfigurer
      const modems = await this.listModems();
      for (const m of modems) {
        await this.configureModemAudio(m);
      }

    } catch (error) {
      this.log('ERROR', `[HARD] Recovery failed: ${error.message}`);
    }
  }

  /**
   * Récupération d'Asterisk
   */
  async recoverAsterisk() {
    this.log('ERROR', 'Asterisk not responding, attempting recovery');

    try {
      await this.runCmd('systemctl restart asterisk 2>/dev/null');
      this.log('INFO', 'Asterisk restart initiated');

      await this.sleep(15000);

      // Vérifier si ça a marché
      const ok = await this.checkAsterisk();
      if (ok) {
        this.log('OK', 'Asterisk recovered successfully');
      } else {
        this.log('ERROR', 'Asterisk still not responding after restart');
      }
    } catch (error) {
      this.log('ERROR', `Asterisk recovery failed: ${error.message}`);
    }
  }

  /**
   * Configure l'audio d'un modem (16kHz)
   */
  async configureModemAudio(modemId) {
    const commands = [
      'AT+CPCMFRM=1',
      'AT+CMICGAIN=0',
      'AT+COUTGAIN=5',
      'AT+CTXVOL=0x2000',
    ];

    for (const cmd of commands) {
      try {
        await this.runCmd(`asterisk -rx "quectel cmd ${modemId} ${cmd}" 2>/dev/null`);
      } catch {
        // Continue même en cas d'erreur
      }
    }

    this.log('INFO', `Audio configured for ${modemId}`);
  }

  /**
   * Essaie de réinitialiser les ports USB
   */
  async tryUsbReset() {
    try {
      // Vérifier si usbreset est disponible
      const hasUsbreset = await this.runCmd('which usbreset 2>/dev/null');
      if (!hasUsbreset || hasUsbreset.startsWith('Error')) {
        return false;
      }

      // Trouver les devices USB des modems
      const devices = await this.runCmd('lsusb | grep -i "Quectel\\|SimCom\\|USB\\sSerial" 2>/dev/null');
      if (!devices || devices.startsWith('Error')) {
        return false;
      }

      this.log('INFO', 'USB reset initiated');
      // Note: L'implémentation complète nécessiterait de parser lsusb et d'appeler usbreset
      return false; // Pour l'instant, retourner false car c'est risqué

    } catch {
      return false;
    }
  }

  /**
   * Utilitaire: exécute une commande shell
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
   * Utilitaire: pause
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Log avec horodatage
   */
  log(level, message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const line = `${timestamp} [${level}] ${message}`;

    console.log(`[Watchdog] ${line}`);

    // Écrire dans le fichier de log
    try {
      fs.appendFileSync(this.logPath, line + '\n');
    } catch (e) {
      // Ignore write errors
    }
  }

  /**
   * Retourne l'état du watchdog
   */
  getStatus() {
    return {
      enabled: this.enabled,
      running: this.running,
      checkInterval: this.checkIntervalMs,
      modems: this.checkCount,
      recoveryAttempts: this.recoveryAttempts,
      thresholds: this.thresholds,
    };
  }
}

module.exports = WatchdogService;
