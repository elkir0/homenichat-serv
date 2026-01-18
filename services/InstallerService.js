/**
 * InstallerService.js
 * Service pour l'installation guidée de composants (Asterisk, chan_quectel, FreePBX)
 * avec suivi en temps réel via SSE
 */

const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Chemins des scripts d'installation
const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');
const INSTALL_VOIP_SCRIPT = path.join(SCRIPTS_DIR, 'install-voip-progress.sh');
const INSTALL_FREEPBX_SCRIPT = path.join(SCRIPTS_DIR, 'install-freepbx-progress.sh');

// État global de l'installation
let currentInstallation = null;

class InstallerService {
  constructor(options = {}) {
    this.logger = options.logger || console;
  }

  /**
   * Exécute une commande shell et retourne le résultat
   */
  runCmd(cmd, timeout = 10000) {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      return null;
    }
  }

  /**
   * Récupère les informations sur l'OS
   */
  getOsInfo() {
    const info = {
      platform: os.platform(),
      arch: os.arch(),
      distro: 'unknown',
      version: 'unknown',
      codename: 'unknown',
    };

    try {
      // Lire /etc/os-release pour les infos de distribution
      if (fs.existsSync('/etc/os-release')) {
        const osRelease = fs.readFileSync('/etc/os-release', 'utf8');
        const idMatch = osRelease.match(/^ID=(.*)$/m);
        const versionMatch = osRelease.match(/^VERSION_ID="?([^"]*)"?$/m);
        const codenameMatch = osRelease.match(/^VERSION_CODENAME=(.*)$/m);

        if (idMatch) info.distro = idMatch[1].replace(/"/g, '');
        if (versionMatch) info.version = versionMatch[1];
        if (codenameMatch) info.codename = codenameMatch[1];
      }
    } catch (error) {
      this.logger.warn('[InstallerService] Failed to read OS info:', error.message);
    }

    return info;
  }

  /**
   * Vérifie si Asterisk est installé et en cours d'exécution
   */
  checkAsterisk() {
    const result = {
      installed: false,
      version: null,
      running: false,
      path: null,
    };

    try {
      // Chercher l'exécutable Asterisk
      const asteriskPath = this.runCmd('which asterisk 2>/dev/null') ||
                          (fs.existsSync('/usr/sbin/asterisk') ? '/usr/sbin/asterisk' : null);

      if (asteriskPath) {
        result.installed = true;
        result.path = asteriskPath;

        // Récupérer la version
        const versionOutput = this.runCmd(`${asteriskPath} -V 2>/dev/null`);
        if (versionOutput) {
          const match = versionOutput.match(/Asterisk\s+(\d+\.\d+\.\d+)/i);
          if (match) result.version = match[1];
        }

        // Vérifier si en cours d'exécution
        const pidCheck = this.runCmd('pgrep -x asterisk 2>/dev/null');
        result.running = !!pidCheck;
      }
    } catch (error) {
      this.logger.warn('[InstallerService] Error checking Asterisk:', error.message);
    }

    return result;
  }

  /**
   * Vérifie si chan_quectel est installé et chargé
   */
  checkChanQuectel() {
    const result = {
      installed: false,
      loaded: false,
      path: null,
    };

    try {
      // Chercher le module chan_quectel
      const modulePaths = [
        '/usr/lib/asterisk/modules/chan_quectel.so',
        '/usr/lib64/asterisk/modules/chan_quectel.so',
        '/usr/local/lib/asterisk/modules/chan_quectel.so',
        '/usr/local/lib/x86_64-linux-gnu/asterisk/modules/chan_quectel.so',
      ];

      for (const modulePath of modulePaths) {
        if (fs.existsSync(modulePath)) {
          result.installed = true;
          result.path = modulePath;
          break;
        }
      }

      // Vérifier si le module est chargé dans Asterisk
      if (result.installed) {
        const moduleList = this.runCmd("asterisk -rx 'module show like quectel' 2>/dev/null");
        if (moduleList && moduleList.includes('chan_quectel')) {
          result.loaded = true;
        }
      }
    } catch (error) {
      this.logger.warn('[InstallerService] Error checking chan_quectel:', error.message);
    }

    return result;
  }

  /**
   * Vérifie si FreePBX est installé
   */
  checkFreePBX() {
    const result = {
      installed: false,
      version: null,
      url: null,
    };

    try {
      // Vérifier le fichier de config FreePBX
      if (fs.existsSync('/etc/freepbx.conf')) {
        result.installed = true;

        // Essayer de récupérer la version via fwconsole
        const versionOutput = this.runCmd('fwconsole -V 2>/dev/null');
        if (versionOutput) {
          const match = versionOutput.match(/(\d+\.\d+\.\d+)/);
          if (match) result.version = match[1];
        }

        // Déterminer l'URL
        const hostname = os.hostname();
        result.url = `http://${hostname}/admin`;
      }
    } catch (error) {
      this.logger.warn('[InstallerService] Error checking FreePBX:', error.message);
    }

    return result;
  }

  /**
   * Vérifie si Gammu est installé
   */
  checkGammu() {
    const result = {
      installed: false,
      version: null,
    };

    try {
      const versionOutput = this.runCmd('gammu --version 2>/dev/null');
      if (versionOutput) {
        result.installed = true;
        const match = versionOutput.match(/Gammu version\s+(\d+\.\d+\.\d+)/i);
        if (match) result.version = match[1];
      }
    } catch (error) {
      // Gammu not installed
    }

    return result;
  }

  /**
   * Détecte les modems USB connectés
   */
  detectUsbModems() {
    const modems = [];

    try {
      const lsusbOutput = this.runCmd('lsusb 2>/dev/null') || '';
      const ttyPorts = this.runCmd('ls /dev/ttyUSB* 2>/dev/null')?.split('\n').filter(p => p) || [];

      // Détecter les SIM7600 (vendor 1e0e)
      const sim7600Matches = lsusbOutput.match(/1e0e:9001/gi) || [];
      const sim7600Count = sim7600Matches.length;

      // Détecter les EC25 (vendor 2c7c)
      const ec25Matches = lsusbOutput.match(/2c7c:0125/gi) || [];
      const ec25Count = ec25Matches.length;

      // Pour chaque SIM7600 détecté (5 ports par modem)
      for (let i = 0; i < sim7600Count; i++) {
        const basePort = i * 5;
        const ports = ttyPorts.slice(basePort, basePort + 5);
        modems.push({
          id: `modem-${i + 1}`,
          type: 'SIM7600',
          vendor: '1e0e',
          product: '9001',
          ports: ports,
          dataPort: ports[2] || `/dev/ttyUSB${basePort + 2}`,
          audioPort: ports[1] || `/dev/ttyUSB${basePort + 1}`,
        });
      }

      // Pour chaque EC25 détecté (4 ports par modem)
      for (let i = 0; i < ec25Count; i++) {
        const basePort = sim7600Count * 5 + i * 4;
        const ports = ttyPorts.slice(basePort, basePort + 4);
        modems.push({
          id: `modem-${sim7600Count + i + 1}`,
          type: 'EC25',
          vendor: '2c7c',
          product: '0125',
          ports: ports,
          dataPort: ports[2] || `/dev/ttyUSB${basePort + 2}`,
          audioPort: ports[1] || `/dev/ttyUSB${basePort + 1}`,
        });
      }

      // Si pas de modem détecté par vendor ID mais des ports ttyUSB existent
      if (modems.length === 0 && ttyPorts.length >= 5) {
        // Supposer SIM7600 si 5+ ports
        const modemCount = Math.floor(ttyPorts.length / 5);
        for (let i = 0; i < modemCount; i++) {
          const basePort = i * 5;
          modems.push({
            id: `modem-${i + 1}`,
            type: 'SIM7600',
            vendor: 'unknown',
            ports: ttyPorts.slice(basePort, basePort + 5),
            dataPort: ttyPorts[basePort + 2],
            audioPort: ttyPorts[basePort + 1],
          });
        }
      }
    } catch (error) {
      this.logger.warn('[InstallerService] Error detecting USB modems:', error.message);
    }

    return modems;
  }

  /**
   * Récupère le statut complet du système
   */
  async getSystemStatus() {
    const os = this.getOsInfo();
    const asterisk = this.checkAsterisk();
    const chanQuectel = this.checkChanQuectel();
    const freepbx = this.checkFreePBX();
    const gammu = this.checkGammu();
    const modems = this.detectUsbModems();

    // Déterminer si on peut installer
    const canInstall = {
      asterisk: !asterisk.installed && os.platform === 'linux',
      freepbx: asterisk.installed && !freepbx.installed && os.platform === 'linux',
      chanQuectel: asterisk.installed && !chanQuectel.installed,
      reason: null,
    };

    if (os.platform !== 'linux') {
      canInstall.reason = 'Installation uniquement disponible sur Linux';
    }

    return {
      // Flat structure for frontend compatibility (ModemsPage.tsx)
      asterisk,
      chanQuectel,
      freepbx,
      gammu,
      modems,  // Array directly for frontend
      platform: { canInstall: os.platform === 'linux' },

      // Nested structure for API consumers (backward compatibility)
      os,
      components: {
        asterisk,
        chanQuectel,
        freepbx,
        gammu,
      },
      modemsInfo: {
        detected: modems.length,
        devices: modems,
      },
      canInstall,
      installing: currentInstallation !== null,
      currentInstallation: currentInstallation ? {
        component: currentInstallation.component,
        startedAt: currentInstallation.startedAt,
        percent: currentInstallation.percent,
        step: currentInstallation.step,
      } : null,
    };
  }

  /**
   * Parse une ligne de sortie du script d'installation
   */
  parseProgressLine(line) {
    // Format: [PROGRESS:percent:step] message
    const progressMatch = line.match(/\[PROGRESS:(\d+):([^\]]+)\]\s*(.*)/);
    if (progressMatch) {
      return {
        type: 'progress',
        percent: parseInt(progressMatch[1], 10),
        step: progressMatch[2],
        message: progressMatch[3],
      };
    }

    // Format: [ERROR] message
    const errorMatch = line.match(/\[ERROR\]\s*(.*)/);
    if (errorMatch) {
      return {
        type: 'error',
        message: errorMatch[1],
      };
    }

    // Format: [WARNING] message
    const warningMatch = line.match(/\[WARNING\]\s*(.*)/);
    if (warningMatch) {
      return {
        type: 'warning',
        message: warningMatch[1],
      };
    }

    // Format: [SUCCESS] message
    const successMatch = line.match(/\[SUCCESS\]\s*(.*)/);
    if (successMatch) {
      return {
        type: 'success',
        message: successMatch[1],
      };
    }

    // Ligne normale
    return {
      type: 'log',
      message: line,
    };
  }

  /**
   * Envoie un événement SSE
   */
  sendSSE(res, eventType, data) {
    if (res.writableEnded) return;

    res.write(`event: ${eventType}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  /**
   * Lance l'installation d'Asterisk + chan_quectel
   */
  async installAsterisk(options, res) {
    if (currentInstallation) {
      this.sendSSE(res, 'error', {
        message: 'Une installation est déjà en cours',
        canRetry: false,
      });
      res.end();
      return;
    }

    // Vérifier que le script existe
    if (!fs.existsSync(INSTALL_VOIP_SCRIPT)) {
      this.sendSSE(res, 'error', {
        message: 'Script d\'installation non trouvé',
        detail: INSTALL_VOIP_SCRIPT,
        canRetry: false,
      });
      res.end();
      return;
    }

    // Configurer la réponse SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Initialiser l'état de l'installation
    currentInstallation = {
      component: 'asterisk',
      startedAt: new Date().toISOString(),
      percent: 0,
      step: 'starting',
      process: null,
    };

    this.sendSSE(res, 'start', {
      component: 'asterisk',
      message: 'Démarrage de l\'installation...',
    });

    // Préparer les arguments du script
    const args = [];
    if (options.modemType) args.push(`--modem-type=${options.modemType}`);
    if (options.installChanQuectel !== false) args.push('--with-chan-quectel');
    if (options.configureModems) args.push('--configure-modems');

    // Lancer le script
    const installProcess = spawn('bash', [INSTALL_VOIP_SCRIPT, ...args], {
      cwd: SCRIPTS_DIR,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive',
      },
    });

    currentInstallation.process = installProcess;

    // Traiter stdout
    installProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parsed = this.parseProgressLine(line);

        if (parsed.type === 'progress') {
          currentInstallation.percent = parsed.percent;
          currentInstallation.step = parsed.step;
          this.sendSSE(res, 'progress', {
            percent: parsed.percent,
            step: parsed.step,
            message: parsed.message,
          });
        } else if (parsed.type === 'success') {
          this.sendSSE(res, 'success', { message: parsed.message });
        } else {
          this.sendSSE(res, 'log', {
            level: parsed.type === 'warning' ? 'warn' : 'info',
            message: parsed.message,
          });
        }
      }
    });

    // Traiter stderr
    installProcess.stderr.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parsed = this.parseProgressLine(line);
        if (parsed.type === 'error') {
          this.sendSSE(res, 'log', { level: 'error', message: parsed.message });
        } else {
          this.sendSSE(res, 'log', { level: 'warn', message: line });
        }
      }
    });

    // Gérer la fin du processus
    installProcess.on('close', (code) => {
      const success = code === 0;

      if (success) {
        this.sendSSE(res, 'complete', {
          success: true,
          message: 'Installation terminée avec succès!',
          nextStep: options.installFreePBX ? 'install_freepbx' : 'configure_modems',
        });
      } else {
        this.sendSSE(res, 'error', {
          message: `Installation échouée (code: ${code})`,
          canRetry: true,
        });
      }

      currentInstallation = null;
      res.end();
    });

    // Gérer les erreurs du processus
    installProcess.on('error', (error) => {
      this.sendSSE(res, 'error', {
        message: `Erreur: ${error.message}`,
        canRetry: true,
      });
      currentInstallation = null;
      res.end();
    });

    // Gérer la déconnexion du client
    res.on('close', () => {
      this.logger.info('[InstallerService] Client disconnected');
      // Ne pas tuer le processus - l'installation continue en arrière-plan
    });
  }

  /**
   * Lance l'installation de FreePBX
   */
  async installFreePBX(options, res) {
    if (currentInstallation) {
      this.sendSSE(res, 'error', {
        message: 'Une installation est déjà en cours',
        canRetry: false,
      });
      res.end();
      return;
    }

    // Vérifier qu'Asterisk est installé
    const asterisk = this.checkAsterisk();
    if (!asterisk.installed) {
      this.sendSSE(res, 'error', {
        message: 'Asterisk doit être installé avant FreePBX',
        canRetry: false,
      });
      res.end();
      return;
    }

    // Vérifier que le script existe
    if (!fs.existsSync(INSTALL_FREEPBX_SCRIPT)) {
      this.sendSSE(res, 'error', {
        message: 'Script d\'installation FreePBX non trouvé',
        detail: INSTALL_FREEPBX_SCRIPT,
        canRetry: false,
      });
      res.end();
      return;
    }

    // Configurer la réponse SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    currentInstallation = {
      component: 'freepbx',
      startedAt: new Date().toISOString(),
      percent: 0,
      step: 'starting',
      process: null,
    };

    this.sendSSE(res, 'start', {
      component: 'freepbx',
      message: 'Démarrage de l\'installation FreePBX...',
    });

    const installProcess = spawn('bash', [INSTALL_FREEPBX_SCRIPT], {
      cwd: SCRIPTS_DIR,
      env: {
        ...process.env,
        DEBIAN_FRONTEND: 'noninteractive',
      },
    });

    currentInstallation.process = installProcess;

    // Même logique que pour Asterisk
    installProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        const parsed = this.parseProgressLine(line);
        if (parsed.type === 'progress') {
          currentInstallation.percent = parsed.percent;
          currentInstallation.step = parsed.step;
          this.sendSSE(res, 'progress', {
            percent: parsed.percent,
            step: parsed.step,
            message: parsed.message,
          });
        } else {
          this.sendSSE(res, 'log', {
            level: parsed.type === 'error' ? 'error' : parsed.type === 'warning' ? 'warn' : 'info',
            message: parsed.message,
          });
        }
      }
    });

    installProcess.stderr.on('data', (data) => {
      this.sendSSE(res, 'log', { level: 'warn', message: data.toString() });
    });

    installProcess.on('close', (code) => {
      const success = code === 0;
      this.sendSSE(res, success ? 'complete' : 'error', {
        success,
        message: success ? 'FreePBX installé avec succès!' : `Installation échouée (code: ${code})`,
        url: success ? `http://${require('os').hostname()}/admin` : undefined,
        canRetry: !success,
      });
      currentInstallation = null;
      res.end();
    });

    installProcess.on('error', (error) => {
      this.sendSSE(res, 'error', { message: error.message, canRetry: true });
      currentInstallation = null;
      res.end();
    });
  }

  /**
   * Annule l'installation en cours
   */
  cancelInstallation() {
    if (!currentInstallation || !currentInstallation.process) {
      return { success: false, message: 'Aucune installation en cours' };
    }

    try {
      currentInstallation.process.kill('SIGTERM');
      // Attendre un peu puis forcer si nécessaire
      setTimeout(() => {
        if (currentInstallation && currentInstallation.process) {
          currentInstallation.process.kill('SIGKILL');
        }
      }, 5000);

      currentInstallation = null;
      return { success: true, message: 'Installation annulée' };
    } catch (error) {
      return { success: false, message: error.message };
    }
  }

  /**
   * Récupère le statut de l'installation en cours
   */
  getInstallationStatus() {
    if (!currentInstallation) {
      return { installing: false };
    }

    return {
      installing: true,
      component: currentInstallation.component,
      percent: currentInstallation.percent,
      step: currentInstallation.step,
      startedAt: currentInstallation.startedAt,
    };
  }
}

module.exports = InstallerService;
