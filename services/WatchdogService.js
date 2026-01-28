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
const EventEmitter = require('events');

class WatchdogService extends EventEmitter {
  constructor(config = {}) {
    super();

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

    // WireGuard tunnel monitoring
    this.wgInterface = config.wgInterface || 'wg-relay';
    this.tunnelRelayService = null;
    this.wgCheckCount = 0;
    this.wgMaxRecoveryAttempts = 3;

    // Last health check result
    this.lastHealthCheck = null;
  }

  /**
   * Inject TunnelRelayService for WireGuard monitoring
   */
  setTunnelRelayService(service) {
    this.tunnelRelayService = service;
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
    const healthResult = {
      timestamp: Date.now(),
      overall: 'ok',
      checks: {
        asterisk: { status: 'unknown' },
        modems: { status: 'unknown' },
        wireguard: { status: 'unknown' },
      },
    };

    try {
      // Vérifier WireGuard tunnel
      const wgOk = await this.checkWireGuard();
      healthResult.checks.wireguard = {
        status: wgOk ? 'ok' : 'warning',
        connected: wgOk,
      };

      // Vérifier Asterisk
      const asteriskOk = await this.checkAsterisk();
      healthResult.checks.asterisk = {
        status: asteriskOk ? 'ok' : 'critical',
        running: asteriskOk,
      };

      if (!asteriskOk) {
        await this.recoverAsterisk();
        healthResult.overall = 'critical';
      }

      // Vérifier chaque modem
      const modemIds = await this.listModems();
      const modemResults = [];

      for (const modemId of modemIds) {
        const status = await this.checkModem(modemId);
        modemResults.push({ id: modemId, ...status });

        if (!status.ok) {
          this.incrementFailure(modemId);
          await this.handleModemFailure(modemId, status);
        } else {
          this.resetFailure(modemId);
        }
      }

      const modemsOk = modemResults.every(m => m.ok);
      healthResult.checks.modems = {
        status: modemResults.length === 0 ? 'ok' : (modemsOk ? 'ok' : 'warning'),
        total: modemResults.length,
        healthy: modemResults.filter(m => m.ok).length,
        modems: modemResults,
      };

      // Determine overall status
      const statuses = Object.values(healthResult.checks).map(c => c.status);
      if (statuses.includes('critical')) {
        healthResult.overall = 'critical';
      } else if (statuses.includes('warning')) {
        healthResult.overall = 'warning';
      }

      // Store and emit result
      this.lastHealthCheck = healthResult;
      this.emit(`health.${healthResult.overall}`, healthResult);
      this.emit('health.check', healthResult);

    } catch (error) {
      this.log('ERROR', `Check error: ${error.message}`);
      healthResult.overall = 'error';
      healthResult.error = error.message;
      this.lastHealthCheck = healthResult;
    }

    return healthResult;
  }

  /**
   * Vérifie l'état du tunnel WireGuard
   */
  async checkWireGuard() {
    // Skip if TunnelRelayService not injected
    if (!this.tunnelRelayService) {
      return true; // Assume OK if not configured
    }

    try {
      const status = await this.tunnelRelayService.getStatus();

      // If not enabled, skip check
      if (!status.enabled) {
        return true;
      }

      // If configured but not connected, attempt recovery
      if (status.configured && !status.connected) {
        this.wgCheckCount++;
        this.log('WARNING', `WireGuard tunnel not connected (failures: ${this.wgCheckCount})`);

        if (this.wgCheckCount >= 3 && this.wgCheckCount < this.wgMaxRecoveryAttempts + 3) {
          await this.recoverWireGuard();
        }

        return false;
      }

      // Check actual interface if connected
      if (status.connected) {
        try {
          const output = execSync(`wg show ${this.wgInterface} 2>/dev/null || true`).toString();
          if (!output.includes('interface')) {
            this.log('WARNING', 'WireGuard interface not found');
            return false;
          }
        } catch {
          return false;
        }
      }

      // Reset counter on success
      this.wgCheckCount = 0;
      return true;

    } catch (error) {
      this.log('ERROR', `WireGuard check failed: ${error.message}`);
      return true; // Don't fail on check error
    }
  }

  /**
   * Récupération du tunnel WireGuard
   */
  async recoverWireGuard() {
    this.log('INFO', 'Attempting WireGuard tunnel recovery');

    try {
      if (this.tunnelRelayService) {
        await this.tunnelRelayService.reconnect();
        this.log('OK', 'WireGuard tunnel recovery initiated');
      }
    } catch (error) {
      this.log('ERROR', `WireGuard recovery failed: ${error.message}`);
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
   * Configure l'audio d'un modem selon son type (EC25 VoLTE UAC vs SIM7600 TTY)
   */
  async configureModemAudio(modemId) {
    // Detect modem type from USB
    const modemType = await this.detectModemType();

    let commands;
    if (modemType === 'ec25') {
      // EC25: VoLTE UAC mode - AT+QAUDMOD=3 + AT+QPCMV=1,2
      // These do NOT persist after modem reboot!
      commands = [
        'AT+QAUDMOD=3',      // USB Audio mode (REQUIRED for VoLTE!)
        'AT+QPCMV=1,2',      // Voice over UAC
        'AT+QEEC=1,1,1024',  // Echo Cancellation Enhanced
      ];
      this.log('INFO', `Configuring EC25 VoLTE UAC audio for ${modemId}`);
    } else {
      // SIM7600: TTY serial audio mode - 16kHz PCM
      commands = [
        'AT+CPCMFRM=1',
        'AT+CMICGAIN=0',
        'AT+COUTGAIN=5',
        'AT+CTXVOL=0x2000',
      ];
      this.log('INFO', `Configuring SIM7600 TTY audio for ${modemId}`);
    }

    for (const cmd of commands) {
      try {
        await this.runCmd(`asterisk -rx "quectel cmd ${modemId} ${cmd}" 2>/dev/null`);
      } catch {
        // Continue even on error
      }
      // EC25 needs more time between AT commands
      if (modemType === 'ec25') {
        await this.sleep(1000);
      }
    }

    // For EC25: verify QAUDMOD was applied
    if (modemType === 'ec25') {
      try {
        const verify = await this.runCmd(`asterisk -rx "quectel cmd ${modemId} AT+QAUDMOD?" 2>/dev/null`);
        if (verify && verify.includes('QAUDMOD: 3')) {
          this.log('OK', `EC25 ${modemId}: QAUDMOD=3 confirmed (VoLTE UAC active)`);
        } else {
          this.log('WARNING', `EC25 ${modemId}: QAUDMOD verification failed: ${verify}`);
        }
      } catch {
        // Non-critical
      }
    }

    this.log('INFO', `Audio configured for ${modemId} (type: ${modemType})`);
  }

  /**
   * Detect modem type from USB vendor ID
   */
  async detectModemType() {
    try {
      const lsusb = await this.runCmd('lsusb 2>/dev/null');
      if (lsusb.includes('2c7c:')) return 'ec25';
      if (lsusb.includes('1e0e:')) return 'sim7600';
    } catch {
      // Fallback
    }
    return 'ec25'; // Default to EC25 (safer - UAC commands are harmless on SIM7600)
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
      wireguard: {
        checkCount: this.wgCheckCount,
        maxRecoveryAttempts: this.wgMaxRecoveryAttempts,
      },
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  /**
   * Force une vérification immédiate
   */
  async forceCheck() {
    return this.runCheck();
  }
}

module.exports = WatchdogService;
