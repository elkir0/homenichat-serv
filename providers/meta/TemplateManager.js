const logger = require('winston');
const axios = require('axios');

/**
 * Gestionnaire des templates WhatsApp
 * Gère la création, modification et utilisation des templates
 */
class TemplateManager {
  constructor(config) {
    this.config = config;
    this.apiVersion = config.apiVersion || 'v18.0';
    this.baseURL = `https://graph.facebook.com/${this.apiVersion}`;
    
    // Cache des templates
    this.templates = new Map();
    this.lastSync = null;
    this.syncInterval = 3600000; // 1 heure
    
    // Catégories de templates
    this.categories = {
      MARKETING: 'marketing',
      UTILITY: 'utility', 
      AUTHENTICATION: 'authentication'
    };
    
    // Langues supportées
    this.supportedLanguages = [
      'af', 'sq', 'ar', 'az', 'bn', 'bg', 'ca', 'zh_CN', 'zh_HK', 'zh_TW',
      'hr', 'cs', 'da', 'nl', 'en', 'en_GB', 'en_US', 'et', 'fil', 'fi',
      'fr', 'ka', 'de', 'el', 'gu', 'ha', 'he', 'hi', 'hu', 'id', 'ga',
      'it', 'ja', 'kn', 'kk', 'rw_RW', 'ko', 'ky_KG', 'lo', 'lv', 'lt',
      'mk', 'ms', 'ml', 'mr', 'nb', 'fa', 'pl', 'pt_BR', 'pt_PT', 'pa',
      'ro', 'ru', 'sr', 'sk', 'sl', 'es', 'es_AR', 'es_ES', 'es_MX', 'sw',
      'sv', 'ta', 'te', 'th', 'tr', 'uk', 'ur', 'uz', 'vi', 'zu'
    ];
  }

  /**
   * Charge tous les templates disponibles
   * @param {boolean} force - Forcer le rechargement même si le cache est récent
   * @returns {Promise<boolean>}
   */
  async loadTemplates(force = false) {
    try {
      // Vérifier si on doit recharger
      if (!force && this.lastSync && (Date.now() - this.lastSync) < this.syncInterval) {
        return true;
      }
      
      const response = await axios.get(
        `${this.baseURL}/${this.config.businessAccountId}/message_templates`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          },
          params: {
            fields: 'name,status,category,language,components',
            limit: 1000
          }
        }
      );
      
      this.templates.clear();
      
      if (response.data && response.data.data) {
        response.data.data.forEach(template => {
          const key = `${template.name}:${template.language}`;
          this.templates.set(key, this.normalizeTemplate(template));
        });
      }
      
      this.lastSync = Date.now();
      logger.info(`Chargé ${this.templates.size} templates`);
      
      return true;
    } catch (error) {
      logger.error('Erreur chargement templates:', error);
      return false;
    }
  }

  /**
   * Obtient un template par nom et langue
   * @param {string} name - Nom du template
   * @param {string} language - Code langue (défaut: fr)
   * @returns {Object|null}
   */
  getTemplate(name, language = 'fr') {
    const key = `${name}:${language}`;
    return this.templates.get(key) || null;
  }

  /**
   * Obtient tous les templates
   * @param {Object} filters - Filtres (category, status, language)
   * @returns {Array}
   */
  getTemplates(filters = {}) {
    let templates = Array.from(this.templates.values());
    
    // Appliquer les filtres
    if (filters.category) {
      templates = templates.filter(t => t.category === filters.category);
    }
    
    if (filters.status) {
      templates = templates.filter(t => t.status === filters.status);
    }
    
    if (filters.language) {
      templates = templates.filter(t => t.language === filters.language);
    }
    
    return templates;
  }

  /**
   * Crée un nouveau template
   * @param {Object} templateData - Données du template
   * @returns {Promise<{success: boolean, template?: Object, error?: string}>}
   */
  async createTemplate(templateData) {
    try {
      const payload = this.buildTemplatePayload(templateData);
      
      const response = await axios.post(
        `${this.baseURL}/${this.config.businessAccountId}/message_templates`,
        payload,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      // Recharger les templates
      await this.loadTemplates(true);
      
      return {
        success: true,
        template: response.data
      };
    } catch (error) {
      logger.error('Erreur création template:', error);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Met à jour un template existant
   * @param {string} templateId - ID du template
   * @param {Object} updates - Mises à jour
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async updateTemplate(templateId, updates) {
    try {
      const response = await axios.post(
        `${this.baseURL}/${templateId}`,
        updates,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          }
        }
      );
      
      // Recharger les templates
      await this.loadTemplates(true);
      
      return { success: true };
    } catch (error) {
      logger.error('Erreur mise à jour template:', error);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Supprime un template
   * @param {string} name - Nom du template
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  async deleteTemplate(name) {
    try {
      const response = await axios.delete(
        `${this.baseURL}/${this.config.businessAccountId}/message_templates`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          },
          params: { name }
        }
      );
      
      // Retirer du cache
      for (const [key, template] of this.templates) {
        if (template.name === name) {
          this.templates.delete(key);
        }
      }
      
      return { success: true };
    } catch (error) {
      logger.error('Erreur suppression template:', error);
      
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message
      };
    }
  }

  /**
   * Construit le payload pour envoyer un message avec template
   * @param {string} to - Numéro destinataire
   * @param {string} templateName - Nom du template
   * @param {Object} parameters - Paramètres du template
   * @param {string} language - Langue du template
   * @returns {Object}
   */
  buildMessagePayload(to, templateName, parameters = {}, language = 'fr') {
    const template = this.getTemplate(templateName, language);
    
    if (!template) {
      throw new Error(`Template non trouvé: ${templateName} (${language})`);
    }
    
    const payload = {
      messaging_product: 'whatsapp',
      to: to,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: language
        }
      }
    };
    
    // Construire les composants avec les paramètres
    const components = [];
    
    // Header avec paramètres
    if (template.components.header && parameters.header) {
      const headerComponent = {
        type: 'header',
        parameters: []
      };
      
      if (template.components.header.format === 'TEXT') {
        // Header texte avec variables
        if (Array.isArray(parameters.header)) {
          headerComponent.parameters = parameters.header.map(text => ({
            type: 'text',
            text: text
          }));
        } else {
          headerComponent.parameters = [{
            type: 'text',
            text: parameters.header
          }];
        }
      } else if (template.components.header.format === 'IMAGE') {
        headerComponent.parameters = [{
          type: 'image',
          image: {
            link: parameters.header
          }
        }];
      } else if (template.components.header.format === 'VIDEO') {
        headerComponent.parameters = [{
          type: 'video',
          video: {
            link: parameters.header
          }
        }];
      } else if (template.components.header.format === 'DOCUMENT') {
        headerComponent.parameters = [{
          type: 'document',
          document: {
            link: parameters.header.link,
            filename: parameters.header.filename
          }
        }];
      }
      
      components.push(headerComponent);
    }
    
    // Body avec paramètres
    if (template.components.body && parameters.body) {
      const bodyParams = Array.isArray(parameters.body) 
        ? parameters.body 
        : [parameters.body];
      
      components.push({
        type: 'body',
        parameters: bodyParams.map(param => ({
          type: 'text',
          text: String(param)
        }))
      });
    }
    
    // Boutons avec paramètres
    if (template.components.buttons && parameters.buttons) {
      parameters.buttons.forEach((button, index) => {
        const buttonComponent = {
          type: 'button',
          sub_type: button.type || 'quick_reply',
          index: index,
          parameters: []
        };
        
        if (button.type === 'url' && button.url) {
          buttonComponent.parameters.push({
            type: 'text',
            text: button.url
          });
        } else if (button.payload) {
          buttonComponent.parameters.push({
            type: 'payload',
            payload: button.payload
          });
        }
        
        components.push(buttonComponent);
      });
    }
    
    if (components.length > 0) {
      payload.template.components = components;
    }
    
    return payload;
  }

  /**
   * Construit le payload pour créer un template
   * @param {Object} templateData - Données du template
   * @returns {Object}
   */
  buildTemplatePayload(templateData) {
    const payload = {
      name: templateData.name,
      category: templateData.category || 'MARKETING',
      language: templateData.language || 'fr',
      components: []
    };
    
    // Header
    if (templateData.header) {
      const headerComponent = {
        type: 'HEADER',
        format: templateData.header.format || 'TEXT'
      };
      
      if (headerComponent.format === 'TEXT') {
        headerComponent.text = templateData.header.text;
        // Ajouter les variables si présentes
        if (templateData.header.variables) {
          headerComponent.example = {
            header_text: templateData.header.variables
          };
        }
      }
      
      payload.components.push(headerComponent);
    }
    
    // Body
    if (templateData.body) {
      const bodyComponent = {
        type: 'BODY',
        text: templateData.body.text
      };
      
      // Ajouter les exemples de variables
      if (templateData.body.examples) {
        bodyComponent.example = {
          body_text: templateData.body.examples
        };
      }
      
      payload.components.push(bodyComponent);
    }
    
    // Footer
    if (templateData.footer) {
      payload.components.push({
        type: 'FOOTER',
        text: templateData.footer
      });
    }
    
    // Boutons
    if (templateData.buttons) {
      const buttonsComponent = {
        type: 'BUTTONS',
        buttons: []
      };
      
      templateData.buttons.forEach(button => {
        if (button.type === 'quick_reply') {
          buttonsComponent.buttons.push({
            type: 'QUICK_REPLY',
            text: button.text
          });
        } else if (button.type === 'phone') {
          buttonsComponent.buttons.push({
            type: 'PHONE_NUMBER',
            text: button.text,
            phone_number: button.phoneNumber
          });
        } else if (button.type === 'url') {
          buttonsComponent.buttons.push({
            type: 'URL',
            text: button.text,
            url: button.url,
            example: button.example
          });
        }
      });
      
      payload.components.push(buttonsComponent);
    }
    
    return payload;
  }

  /**
   * Normalise un template depuis l'API
   * @param {Object} rawTemplate - Template brut de l'API
   * @returns {Object}
   */
  normalizeTemplate(rawTemplate) {
    const normalized = {
      id: rawTemplate.id,
      name: rawTemplate.name,
      status: rawTemplate.status,
      category: rawTemplate.category,
      language: rawTemplate.language,
      components: {}
    };
    
    // Parser les composants
    if (rawTemplate.components) {
      rawTemplate.components.forEach(component => {
        switch (component.type) {
          case 'HEADER':
            normalized.components.header = {
              format: component.format,
              text: component.text,
              variables: this.extractVariables(component.text)
            };
            break;
            
          case 'BODY':
            normalized.components.body = {
              text: component.text,
              variables: this.extractVariables(component.text)
            };
            break;
            
          case 'FOOTER':
            normalized.components.footer = component.text;
            break;
            
          case 'BUTTONS':
            normalized.components.buttons = component.buttons.map(button => ({
              type: button.type.toLowerCase(),
              text: button.text,
              url: button.url,
              phoneNumber: button.phone_number
            }));
            break;
        }
      });
    }
    
    return normalized;
  }

  /**
   * Extrait les variables d'un texte de template
   * @param {string} text - Texte du template
   * @returns {Array} Variables trouvées
   */
  extractVariables(text) {
    if (!text) return [];
    
    const regex = /\{\{(\d+)\}\}/g;
    const variables = [];
    let match;
    
    while ((match = regex.exec(text)) !== null) {
      variables.push({
        index: parseInt(match[1]),
        placeholder: match[0]
      });
    }
    
    return variables;
  }

  /**
   * Valide les paramètres pour un template
   * @param {string} templateName - Nom du template
   * @param {Object} parameters - Paramètres fournis
   * @param {string} language - Langue
   * @returns {Object} {valid: boolean, errors?: Array}
   */
  validateParameters(templateName, parameters, language = 'fr') {
    const template = this.getTemplate(templateName, language);
    
    if (!template) {
      return {
        valid: false,
        errors: [`Template non trouvé: ${templateName}`]
      };
    }
    
    const errors = [];
    
    // Valider header
    if (template.components.header && template.components.header.variables.length > 0) {
      if (!parameters.header) {
        errors.push('Paramètres header manquants');
      } else if (Array.isArray(parameters.header)) {
        if (parameters.header.length !== template.components.header.variables.length) {
          errors.push(`Header attend ${template.components.header.variables.length} paramètres`);
        }
      }
    }
    
    // Valider body
    if (template.components.body && template.components.body.variables.length > 0) {
      if (!parameters.body) {
        errors.push('Paramètres body manquants');
      } else if (Array.isArray(parameters.body)) {
        if (parameters.body.length !== template.components.body.variables.length) {
          errors.push(`Body attend ${template.components.body.variables.length} paramètres`);
        }
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Obtient les statistiques d'utilisation des templates
   * @returns {Promise<Object>}
   */
  async getTemplateAnalytics() {
    try {
      const response = await axios.get(
        `${this.baseURL}/${this.config.businessAccountId}/template_analytics`,
        {
          headers: {
            'Authorization': `Bearer ${this.config.accessToken}`
          },
          params: {
            start: Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000), // 30 derniers jours
            end: Math.floor(Date.now() / 1000),
            granularity: 'daily'
          }
        }
      );
      
      return response.data;
    } catch (error) {
      logger.error('Erreur récupération analytics templates:', error);
      return null;
    }
  }
}

module.exports = TemplateManager;