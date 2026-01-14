const logger = require('winston');

class WebSocketManager {
  static instance = null;
  
  constructor() {
    this.broadcastFunction = null;
  }
  
  static getInstance() {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }
  
  setBroadcastFunction(fn) {
    this.broadcastFunction = fn;
  }
  
  broadcastToChat(chatId, message) {
    if (this.broadcastFunction) {
      logger.info('WebSocketManager: Broadcasting message', {
        chatId: chatId,
        messageType: message.type,
        hasData: !!message.data
      });
      this.broadcastFunction(chatId, message);
    } else {
      logger.warn('WebSocket broadcast function not set');
    }
  }
}

module.exports = WebSocketManager.getInstance();