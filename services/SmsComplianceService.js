/**
 * SmsComplianceService - Service de conformité SMS par pays
 *
 * Gère les règles légales pour l'envoi de SMS commerciaux:
 * - France: CNIL/ARCEP (horaires 8h-22h, mention STOP obligatoire)
 * - Belgique: Similar RGPD rules
 * - Autres pays: Configurable
 *
 * Ce service vérifie AVANT l'envoi que le message respecte les règles.
 */

const logger = require('../utils/logger');

class SmsComplianceService {
  constructor() {
    // Règles par défaut par pays
    this.rules = {
      FR: {
        name: 'France',
        enabled: true,
        // Mots-clés de désabonnement obligatoires
        stopKeywords: ['STOP', 'ARRET', 'DESABONNER', 'STOP SMS'],
        // Restrictions horaires (CNIL/ARCEP pour SMS commerciaux)
        timeRestrictions: {
          start: 8, // 8h00
          end: 22,  // 22h00
          timezone: 'Europe/Paris',
          blockedDays: ['sunday'] // Dimanche interdit pour SMS commerciaux
        },
        // Longueur max (GSM-7 = 160, Unicode = 70)
        maxLength: {
          gsm7: 160,
          unicode: 70,
          concatenatedMax: 10 // Max 10 segments
        },
        // Mention STOP obligatoire pour SMS commerciaux
        requireStopMention: true,
        stopMentionFormat: 'STOP au {sender}',
        // Délai minimum entre SMS vers même destinataire (anti-spam)
        minDelayBetweenSms: 60, // secondes
        // Types de numéros autorisés
        allowedPrefixes: ['+33'],
        blockedPrefixes: ['+338'] // Numéros spéciaux
      },
      BE: {
        name: 'Belgique',
        enabled: true,
        stopKeywords: ['STOP', 'ARRET'],
        timeRestrictions: {
          start: 8,
          end: 20,
          timezone: 'Europe/Brussels',
          blockedDays: ['sunday']
        },
        requireStopMention: true,
        stopMentionFormat: 'STOP au {sender}',
        allowedPrefixes: ['+32']
      },
      CH: {
        name: 'Suisse',
        enabled: true,
        stopKeywords: ['STOP'],
        timeRestrictions: {
          start: 7,
          end: 21,
          timezone: 'Europe/Zurich',
          blockedDays: []
        },
        requireStopMention: true,
        allowedPrefixes: ['+41']
      }
    };

    // Cache pour anti-spam
    this.recentSms = new Map(); // destinataire -> timestamp
  }

  /**
   * Vérifie si un SMS peut être envoyé selon les règles de compliance
   * @param {string} to - Numéro destinataire (format E.164)
   * @param {string} text - Contenu du message
   * @param {string} country - Code pays (FR, BE, CH...)
   * @param {Object} providerConfig - Configuration du provider (pour sender)
   * @returns {{allowed: boolean, reason?: string, warnings: string[], modifiedText?: string}}
   */
  check(to, text, country = 'FR', providerConfig = {}) {
    const result = {
      allowed: true,
      warnings: [],
      modifiedText: text
    };

    const rules = this.getCountryRules(country);
    if (!rules || !rules.enabled) {
      // Pas de règles pour ce pays, autoriser par défaut
      return result;
    }

    // 1. Vérifier le préfixe du numéro
    const prefixCheck = this.checkNumberPrefix(to, rules);
    if (!prefixCheck.allowed) {
      return { allowed: false, reason: prefixCheck.reason, warnings: [] };
    }

    // 2. Vérifier les restrictions horaires
    const timeCheck = this.checkTimeRestrictions(rules);
    if (!timeCheck.allowed) {
      return { allowed: false, reason: timeCheck.reason, warnings: [] };
    }

    // 3. Vérifier le jour de la semaine
    const dayCheck = this.checkBlockedDays(rules);
    if (!dayCheck.allowed) {
      return { allowed: false, reason: dayCheck.reason, warnings: [] };
    }

    // 4. Vérifier/ajouter la mention STOP
    if (rules.requireStopMention) {
      const stopCheck = this.checkAndAddStopMention(text, rules, providerConfig);
      result.modifiedText = stopCheck.modifiedText;
      if (stopCheck.added) {
        result.warnings.push('Mention STOP ajoutée automatiquement');
      }
    }

    // 5. Vérifier la longueur du message
    const lengthCheck = this.checkMessageLength(result.modifiedText, rules);
    if (lengthCheck.warning) {
      result.warnings.push(lengthCheck.warning);
    }

    // 6. Vérifier l'anti-spam (délai entre SMS)
    const spamCheck = this.checkAntiSpam(to, rules);
    if (!spamCheck.allowed) {
      return { allowed: false, reason: spamCheck.reason, warnings: [] };
    }

    // Enregistrer l'envoi pour l'anti-spam
    this.recordSms(to);

    return result;
  }

  /**
   * Récupère les règles d'un pays
   */
  getCountryRules(country) {
    return this.rules[country.toUpperCase()];
  }

  /**
   * Détecte le pays à partir du numéro
   */
  detectCountry(phoneNumber) {
    if (phoneNumber.startsWith('+33')) return 'FR';
    if (phoneNumber.startsWith('+32')) return 'BE';
    if (phoneNumber.startsWith('+41')) return 'CH';
    if (phoneNumber.startsWith('+49')) return 'DE';
    if (phoneNumber.startsWith('+34')) return 'ES';
    if (phoneNumber.startsWith('+39')) return 'IT';
    if (phoneNumber.startsWith('+44')) return 'GB';
    return null;
  }

  /**
   * Vérifie le préfixe du numéro
   */
  checkNumberPrefix(to, rules) {
    // Vérifier les préfixes bloqués
    if (rules.blockedPrefixes) {
      for (const prefix of rules.blockedPrefixes) {
        if (to.startsWith(prefix)) {
          return {
            allowed: false,
            reason: `Numéro ${to} non autorisé (préfixe bloqué: ${prefix})`
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Vérifie les restrictions horaires
   */
  checkTimeRestrictions(rules) {
    if (!rules.timeRestrictions) {
      return { allowed: true };
    }

    const now = new Date();
    // Obtenir l'heure dans le fuseau horaire du pays
    const options = { timeZone: rules.timeRestrictions.timezone, hour: 'numeric', hour12: false };
    const hour = parseInt(new Intl.DateTimeFormat('fr-FR', options).format(now));

    const { start, end } = rules.timeRestrictions;

    if (hour < start || hour >= end) {
      return {
        allowed: false,
        reason: `Envoi SMS interdit entre ${end}h et ${start}h (actuellement ${hour}h, fuseau ${rules.timeRestrictions.timezone})`
      };
    }

    return { allowed: true };
  }

  /**
   * Vérifie les jours bloqués
   */
  checkBlockedDays(rules) {
    if (!rules.timeRestrictions?.blockedDays?.length) {
      return { allowed: true };
    }

    const now = new Date();
    const options = { timeZone: rules.timeRestrictions.timezone, weekday: 'long' };
    const dayName = new Intl.DateTimeFormat('en-US', options).format(now).toLowerCase();

    if (rules.timeRestrictions.blockedDays.includes(dayName)) {
      return {
        allowed: false,
        reason: `Envoi SMS commercial interdit le ${dayName}`
      };
    }

    return { allowed: true };
  }

  /**
   * Vérifie et ajoute la mention STOP si nécessaire
   */
  checkAndAddStopMention(text, rules, providerConfig) {
    const lowerText = text.toLowerCase();

    // Vérifier si une mention STOP existe déjà
    const hasStopMention = rules.stopKeywords.some(keyword =>
      lowerText.includes(keyword.toLowerCase())
    );

    if (hasStopMention) {
      return { modifiedText: text, added: false };
    }

    // Ajouter la mention STOP
    const sender = providerConfig?.config?.sender ||
                   providerConfig?.sender ||
                   'EXPEDITEUR';

    const stopMention = (rules.stopMentionFormat || 'STOP au {sender}')
      .replace('{sender}', sender);

    return {
      modifiedText: `${text}\n${stopMention}`,
      added: true
    };
  }

  /**
   * Vérifie la longueur du message
   */
  checkMessageLength(text, rules) {
    if (!rules.maxLength) {
      return { warning: null };
    }

    // Détecter si le texte contient des caractères Unicode
    const isUnicode = /[^\x00-\x7F]/.test(text);
    const charLimit = isUnicode ? rules.maxLength.unicode : rules.maxLength.gsm7;
    const maxChars = charLimit * (rules.maxLength.concatenatedMax || 10);

    if (text.length > maxChars) {
      return {
        warning: `Message trop long (${text.length} caractères, max ${maxChars}). Il sera tronqué.`
      };
    }

    const segments = Math.ceil(text.length / charLimit);
    if (segments > 1) {
      return {
        warning: `Message divisé en ${segments} segments (${text.length} caractères)`
      };
    }

    return { warning: null };
  }

  /**
   * Vérifie le délai anti-spam
   */
  checkAntiSpam(to, rules) {
    if (!rules.minDelayBetweenSms) {
      return { allowed: true };
    }

    const lastSms = this.recentSms.get(to);
    if (!lastSms) {
      return { allowed: true };
    }

    const elapsedSeconds = (Date.now() - lastSms) / 1000;
    if (elapsedSeconds < rules.minDelayBetweenSms) {
      return {
        allowed: false,
        reason: `Anti-spam: attendez ${Math.ceil(rules.minDelayBetweenSms - elapsedSeconds)}s avant de renvoyer un SMS à ${to}`
      };
    }

    return { allowed: true };
  }

  /**
   * Enregistre un envoi pour l'anti-spam
   */
  recordSms(to) {
    this.recentSms.set(to, Date.now());

    // Nettoyer les anciennes entrées (plus de 5 minutes)
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const [number, timestamp] of this.recentSms.entries()) {
      if (timestamp < fiveMinutesAgo) {
        this.recentSms.delete(number);
      }
    }
  }

  /**
   * Vérifie si un message est une demande de désabonnement
   * @param {string} text - Texte du message entrant
   * @param {string} country - Code pays
   * @returns {boolean}
   */
  isStopRequest(text, country = 'FR') {
    const rules = this.getCountryRules(country);
    if (!rules?.stopKeywords) {
      return false;
    }

    const normalizedText = text.trim().toUpperCase();
    return rules.stopKeywords.some(keyword =>
      normalizedText === keyword.toUpperCase() ||
      normalizedText.startsWith(keyword.toUpperCase() + ' ')
    );
  }

  /**
   * Met à jour les règles d'un pays depuis la configuration YAML
   */
  updateRulesFromConfig(complianceConfig) {
    if (!complianceConfig?.sms) {
      return;
    }

    for (const [country, config] of Object.entries(complianceConfig.sms)) {
      if (this.rules[country.toUpperCase()]) {
        // Fusionner avec les règles existantes
        this.rules[country.toUpperCase()] = {
          ...this.rules[country.toUpperCase()],
          enabled: config.enabled ?? true,
          stopKeywords: config.stop_keywords || this.rules[country.toUpperCase()].stopKeywords,
          timeRestrictions: config.time_restrictions ? {
            start: parseInt(config.time_restrictions.start?.split(':')[0]) || 8,
            end: parseInt(config.time_restrictions.end?.split(':')[0]) || 22,
            timezone: config.time_restrictions.timezone || 'Europe/Paris',
            blockedDays: config.time_restrictions.blocked_days || []
          } : this.rules[country.toUpperCase()].timeRestrictions
        };
      } else {
        // Créer de nouvelles règles
        this.rules[country.toUpperCase()] = {
          name: country,
          enabled: config.enabled ?? true,
          stopKeywords: config.stop_keywords || ['STOP'],
          timeRestrictions: config.time_restrictions ? {
            start: parseInt(config.time_restrictions.start?.split(':')[0]) || 8,
            end: parseInt(config.time_restrictions.end?.split(':')[0]) || 22,
            timezone: config.time_restrictions.timezone || 'UTC',
            blockedDays: config.time_restrictions.blocked_days || []
          } : null,
          requireStopMention: true
        };
      }
    }

    logger.info('[SmsCompliance] Rules updated from configuration');
  }

  /**
   * Retourne les règles actives pour debug/admin
   */
  getAllRules() {
    return { ...this.rules };
  }
}

// Export singleton
module.exports = new SmsComplianceService();
