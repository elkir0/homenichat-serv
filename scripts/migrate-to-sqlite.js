/**
 * Script de migration vers SQLite
 * Transfère les données de bailey_store.json et database-memory.js vers homenichat.db
 */
const fs = require('fs');
const path = require('path');
const db = require('../services/DatabaseService');

async function migrate() {
    console.log('🚀 Starting migration to SQLite...');

    try {
        // 1. Migrer les Utilisateurs (depuis database-memory.js en dur ou fichier)
        // Note: database-memory.js est un module, on ne peut pas le lire facilement si c'est du JS exécuté.
        // On va supposer qu'on recrée l'admin par défaut car database-memory était volatil.
        // Si vous aviez un mécanisme de persistance (fichier json), on le lirait ici.

        const adminUser = db.getUserByUsername('admin');
        if (!adminUser) {
            console.log('creating default admin user...');
            db.createUser('admin', 'admin123', 'admin');
        } else {
            console.log('Admin user already exists.');
        }

        // 2. Migrer les Chats & Messages (depuis baileys_store.json)
        const storePath = path.join(__dirname, '../baileys_store.json');
        if (fs.existsSync(storePath)) {
            console.log(`📂 Found baileys_store.json, reading...`);
            const storeData = JSON.parse(fs.readFileSync(storePath, 'utf8'));

            const chats = storeData.chats || [];
            const messages = storeData.messages || {};

            console.log(`Found ${chats.length} chats and messages for ${Object.keys(messages).length} chats.`);

            db.transaction(() => {
                // Import Chats
                const chatStmt = db.prepare(`
          INSERT OR REPLACE INTO chats (id, name, unread_count, timestamp, provider)
          VALUES (@id, @name, @unreadCount, @timestamp, 'whatsapp')
        `);

                for (const chat of chats) {
                    chatStmt.run({
                        id: chat.id,
                        name: chat.name || chat.verifiedName || chat.id,
                        unreadCount: chat.unreadCount || 0,
                        timestamp: chat.conversationTimestamp || Date.now() / 1000
                    });
                }
                console.log('✅ Chats imported.');

                // Import Messages
                const msgStmt = db.prepare(`
          INSERT OR IGNORE INTO messages (id, chat_id, sender_id, from_me, type, content, timestamp, status, raw_data)
          VALUES (@id, @chatId, @senderId, @fromMe, @type, @content, @timestamp, @status, @rawData)
        `);

                let msgCount = 0;
                for (const [chatId, chatMsgs] of Object.entries(messages)) {
                    for (const msg of chatMsgs) {
                        // Extraction basique
                        const key = msg.key;
                        if (!key || !key.id) continue;

                        const content = getMessageContent(msg);

                        msgStmt.run({
                            id: key.id,
                            chatId: chatId,
                            senderId: key.participant || key.remoteJid, // Pour les groupes
                            fromMe: key.fromMe ? 1 : 0,
                            type: getMessageType(msg),
                            content: content,
                            timestamp: (msg.messageTimestamp?.low || msg.messageTimestamp) || Date.now() / 1000,
                            status: msg.status || 'received',
                            rawData: JSON.stringify(msg)
                        });
                        msgCount++;
                    }
                }
                console.log(`✅ ${msgCount} Messages imported.`);
            })();

        } else {
            console.log('⚠️ baileys_store.json not found. Skipping chat migration.');
        }

        console.log('🎉 Migration completed successfully!');
        process.exit(0);

    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

// Helpers
function getMessageType(msg) {
    if (!msg.message) return 'unknown';
    if (msg.message.conversation) return 'text';
    if (msg.message.imageMessage) return 'image';
    if (msg.message.videoMessage) return 'video';
    if (msg.message.audioMessage) return 'audio';
    if (msg.message.extendedTextMessage) return 'text';
    return 'other';
}

function getMessageContent(msg) {
    if (!msg.message) return '';
    if (msg.message.conversation) return msg.message.conversation;
    if (msg.message.extendedTextMessage?.text) return msg.message.extendedTextMessage.text;
    if (msg.message.imageMessage?.caption) return msg.message.imageMessage.caption;
    return '';
}

migrate();
