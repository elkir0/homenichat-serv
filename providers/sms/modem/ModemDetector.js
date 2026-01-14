/**
 * ModemDetector - Détection automatique des modems USB
 *
 * Détecte les modems GSM USB connectés (SIM7600, EC25, etc.)
 * et identifie les ports série associés.
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');

// Types de modems supportés
const MODEM_SIGNATURES = {
  SIM7600: {
    vendorId: '1e0e',
    productIds: ['9001', '9011'],
    name: 'SIM7600',
    atPort: 2,  // Interface pour commandes AT
    audioPort: 4,  // Interface pour audio PCM
  },
  EC25: {
    vendorId: '2c7c',
    productIds: ['0125'],
    name: 'EC25',
    atPort: 2,
    audioPort: 3,
  },
  GENERIC: {
    vendorId: null,
    productIds: [],
    name: 'Generic GSM',
    atPort: 0,
  },
};

class ModemDetector extends EventEmitter {
  constructor() {
    super();
    this.detectedModems = new Map();
    this.watchInterval = null;
  }

  /**
   * Détecte tous les modems USB connectés
   * @returns {Promise<Array>} Liste des modems détectés
   */
  async detectModems() {
    const modems = [];

    try {
      // Méthode 1: Lire les ports série USB
      const serialPorts = await this.getSerialPorts();

      // Méthode 2: Lire les informations USB
      const usbDevices = this.getUsbDevices();

      // Corréler les ports série avec les devices USB
      for (const port of serialPorts) {
        const modem = this.identifyModem(port, usbDevices);
        if (modem) {
          modems.push(modem);
        }
      }

      // Mettre à jour le cache
      this.updateCache(modems);

      return modems;
    } catch (error) {
      console.error('Error detecting modems:', error);
      return [];
    }
  }

  /**
   * Récupère la liste des ports série
   */
  async getSerialPorts() {
    const ports = [];

    try {
      // Linux: lire /dev/ttyUSB* et /dev/ttyACM*
      const devPath = '/dev';
      const files = fs.readdirSync(devPath);

      for (const file of files) {
        if (file.startsWith('ttyUSB') || file.startsWith('ttyACM')) {
          const fullPath = path.join(devPath, file);

          // Lire les infos du device via udevadm
          const info = this.getDeviceInfo(fullPath);

          ports.push({
            path: fullPath,
            name: file,
            ...info,
          });
        }
      }
    } catch (error) {
      // Essayer avec serialport si disponible
      try {
        const { SerialPort } = require('serialport');
        const serialPorts = await SerialPort.list();

        for (const sp of serialPorts) {
          if (sp.path.includes('ttyUSB') || sp.path.includes('ttyACM')) {
            ports.push({
              path: sp.path,
              name: path.basename(sp.path),
              vendorId: sp.vendorId,
              productId: sp.productId,
              manufacturer: sp.manufacturer,
              serialNumber: sp.serialNumber,
            });
          }
        }
      } catch (e) {
        console.error('SerialPort not available:', e.message);
      }
    }

    return ports;
  }

  /**
   * Récupère les informations d'un device via udevadm
   */
  getDeviceInfo(devicePath) {
    try {
      const output = execSync(`udevadm info --query=property ${devicePath}`, {
        encoding: 'utf8',
        timeout: 5000,
      });

      const info = {};
      const lines = output.split('\n');

      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key && value) {
          info[key.trim()] = value.trim();
        }
      }

      return {
        vendorId: info.ID_VENDOR_ID,
        productId: info.ID_MODEL_ID,
        manufacturer: info.ID_VENDOR,
        model: info.ID_MODEL,
        serialNumber: info.ID_SERIAL_SHORT,
        driver: info.ID_USB_DRIVER,
        interface: info.ID_USB_INTERFACE_NUM,
      };
    } catch (error) {
      return {};
    }
  }

  /**
   * Récupère la liste des devices USB
   */
  getUsbDevices() {
    const devices = [];

    try {
      const output = execSync('lsusb', { encoding: 'utf8' });
      const lines = output.split('\n');

      for (const line of lines) {
        // Format: Bus XXX Device YYY: ID VVVV:PPPP Description
        const match = line.match(/Bus (\d+) Device (\d+): ID ([0-9a-f]+):([0-9a-f]+) (.+)/i);
        if (match) {
          devices.push({
            bus: match[1],
            device: match[2],
            vendorId: match[3],
            productId: match[4],
            description: match[5],
          });
        }
      }
    } catch (error) {
      console.error('lsusb not available:', error.message);
    }

    return devices;
  }

  /**
   * Identifie le type de modem à partir des informations du port
   */
  identifyModem(port, usbDevices) {
    // Chercher la signature du modem
    for (const [type, signature] of Object.entries(MODEM_SIGNATURES)) {
      if (signature.vendorId && port.vendorId === signature.vendorId) {
        if (signature.productIds.length === 0 ||
            signature.productIds.includes(port.productId)) {

          // Vérifier si c'est le port AT
          const interfaceNum = parseInt(port.interface || '0', 10);

          return {
            id: `modem_${port.name}`,
            type: type.toLowerCase(),
            name: signature.name,
            device: port.path,
            vendorId: port.vendorId,
            productId: port.productId,
            manufacturer: port.manufacturer,
            serialNumber: port.serialNumber,
            isAtPort: interfaceNum === signature.atPort,
            isAudioPort: interfaceNum === signature.audioPort,
            interfaceNum,
          };
        }
      }
    }

    // Modem générique si port série avec driver option ou qcserial
    if (port.driver === 'option' || port.driver === 'qcserial') {
      return {
        id: `modem_${port.name}`,
        type: 'generic',
        name: port.model || 'GSM Modem',
        device: port.path,
        vendorId: port.vendorId,
        productId: port.productId,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        isAtPort: true, // Assume AT port
      };
    }

    return null;
  }

  /**
   * Met à jour le cache des modems détectés
   */
  updateCache(modems) {
    const currentIds = new Set(modems.map(m => m.id));
    const previousIds = new Set(this.detectedModems.keys());

    // Nouveaux modems
    for (const modem of modems) {
      if (!this.detectedModems.has(modem.id)) {
        this.detectedModems.set(modem.id, modem);
        this.emit('modem_connected', modem);
      }
    }

    // Modems déconnectés
    for (const id of previousIds) {
      if (!currentIds.has(id)) {
        const modem = this.detectedModems.get(id);
        this.detectedModems.delete(id);
        this.emit('modem_disconnected', modem);
      }
    }
  }

  /**
   * Trouve les ports AT pour un modem spécifique
   */
  findAtPorts() {
    return Array.from(this.detectedModems.values()).filter(m => m.isAtPort);
  }

  /**
   * Démarre la surveillance des modems USB
   */
  startWatching(intervalMs = 5000) {
    if (this.watchInterval) {
      return;
    }

    // Détection initiale
    this.detectModems();

    // Surveillance périodique
    this.watchInterval = setInterval(() => {
      this.detectModems();
    }, intervalMs);

    console.log('ModemDetector: Started watching for USB modems');
  }

  /**
   * Arrête la surveillance
   */
  stopWatching() {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = null;
      console.log('ModemDetector: Stopped watching');
    }
  }

  /**
   * Retourne les modems actuellement détectés
   */
  getDetectedModems() {
    return Array.from(this.detectedModems.values());
  }

  /**
   * Teste si un port répond aux commandes AT
   */
  async testAtPort(devicePath, timeout = 3000) {
    return new Promise((resolve) => {
      try {
        const { SerialPort } = require('serialport');

        const port = new SerialPort({
          path: devicePath,
          baudRate: 115200,
          autoOpen: false,
        });

        let responded = false;
        let response = '';

        port.on('data', (data) => {
          response += data.toString();
          if (response.includes('OK') || response.includes('ERROR')) {
            responded = true;
            port.close();
            resolve({
              success: response.includes('OK'),
              response: response.trim(),
            });
          }
        });

        port.on('error', (err) => {
          resolve({ success: false, error: err.message });
        });

        port.open((err) => {
          if (err) {
            resolve({ success: false, error: err.message });
            return;
          }

          // Envoyer commande AT
          port.write('AT\r\n');

          // Timeout
          setTimeout(() => {
            if (!responded) {
              port.close();
              resolve({ success: false, error: 'Timeout' });
            }
          }, timeout);
        });
      } catch (error) {
        resolve({ success: false, error: error.message });
      }
    });
  }
}

module.exports = ModemDetector;
