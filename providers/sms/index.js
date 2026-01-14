/**
 * SMS Providers Index - Factory et exports
 *
 * Ce module permet de créer des instances de providers SMS
 * en fonction du type spécifié dans la configuration.
 */

const logger = require('../../utils/logger');

// Import des providers
const SmsProvider = require('./base/SmsProvider');

// Providers Cloud
const OvhSmsProvider = require('./cloud/OvhSmsProvider');
const TwilioSmsProvider = require('./cloud/TwilioSmsProvider');

// Note: Les providers suivants seront ajoutés progressivement
// const PlivoSmsProvider = require('./cloud/PlivoSmsProvider');
// const MessageBirdProvider = require('./cloud/MessageBirdProvider');
// const VonageSmsProvider = require('./cloud/VonageSmsProvider');

// Providers Protocol
// const SmppProvider = require('./protocol/SmppProvider');
// const SipMessageProvider = require('./protocol/SipMessageProvider');

// Providers Modem (USB GSM)
const { AtCommandProvider, GammuModemProvider, ModemDetector } = require('./modem');

// Provider VM500 (infrastructure de production existante)
const Vm500SmsProvider = require('./Vm500SmsProvider');

// Le SmsBridgeProvider existant (legacy)
const SmsBridgeProvider = require('./SmsBridgeProvider');

/**
 * Registry des types de providers disponibles
 */
const providerRegistry = {
  // Cloud providers
  ovh: OvhSmsProvider,
  twilio: TwilioSmsProvider,
  // plivo: PlivoSmsProvider,
  // messagebird: MessageBirdProvider,
  // vonage: VonageSmsProvider,

  // Protocol providers
  // smpp: SmppProvider,
  // sip_message: SipMessageProvider,

  // Modem providers (USB GSM direct)
  at_command: AtCommandProvider,
  gammu: GammuModemProvider,

  // VM500 infrastructure existante
  vm500: Vm500SmsProvider,

  // Legacy SMS Bridge
  sms_bridge: SmsBridgeProvider
};

/**
 * Crée une instance de provider SMS
 * @param {Object} config - Configuration du provider
 * @param {string} config.type - Type de provider (ovh, twilio, etc.)
 * @param {string} config.id - ID unique du provider
 * @param {boolean} config.enabled - Si le provider est activé
 * @param {Object} config.config - Configuration spécifique au provider
 * @returns {SmsProvider} Instance du provider
 */
function createSmsProvider(config) {
  const type = config.type;

  if (!type) {
    throw new Error('Provider type is required');
  }

  const ProviderClass = providerRegistry[type];

  if (!ProviderClass) {
    const available = Object.keys(providerRegistry).join(', ');
    throw new Error(`Unknown SMS provider type: ${type}. Available: ${available}`);
  }

  logger.info(`[SmsFactory] Creating provider: ${config.id} (type: ${type})`);
  return new ProviderClass(config);
}

/**
 * Retourne la liste des types de providers disponibles
 * @returns {string[]}
 */
function getAvailableProviderTypes() {
  return Object.keys(providerRegistry);
}

/**
 * Vérifie si un type de provider est disponible
 * @param {string} type - Type de provider
 * @returns {boolean}
 */
function isProviderTypeAvailable(type) {
  return type in providerRegistry;
}

/**
 * Enregistre un nouveau type de provider
 * @param {string} type - Type de provider
 * @param {typeof SmsProvider} ProviderClass - Classe du provider
 */
function registerProviderType(type, ProviderClass) {
  if (!(ProviderClass.prototype instanceof SmsProvider)) {
    throw new Error('Provider class must extend SmsProvider');
  }
  providerRegistry[type] = ProviderClass;
  logger.info(`[SmsFactory] Registered new provider type: ${type}`);
}

module.exports = {
  // Factory
  createSmsProvider,

  // Registry helpers
  getAvailableProviderTypes,
  isProviderTypeAvailable,
  registerProviderType,

  // Classes directes pour import si nécessaire
  SmsProvider,
  OvhSmsProvider,
  TwilioSmsProvider,
  SmsBridgeProvider,

  // Modem providers
  AtCommandProvider,
  GammuModemProvider,
  ModemDetector,

  // VM500 provider
  Vm500SmsProvider,
};
