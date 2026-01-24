/**
 * Settings Repository
 * Key-value store for application settings
 */

const getDb = () => require('./index').db;

const SettingsRepository = {
    /**
     * Get a setting value
     */
    get(key) {
        const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (!row) return null;
        try {
            return JSON.parse(row.value);
        } catch (e) {
            return row.value;
        }
    },

    /**
     * Set a setting value
     */
    set(key, value) {
        const jsonValue = typeof value === 'string' ? value : JSON.stringify(value);
        return getDb().prepare(`
            INSERT INTO settings (key, value, updated_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        `).run(key, jsonValue);
    },

    /**
     * Delete a setting
     */
    delete(key) {
        return getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
    },

    /**
     * Get all settings
     */
    getAll() {
        const rows = getDb().prepare('SELECT key, value FROM settings').all();
        const settings = {};
        for (const row of rows) {
            try {
                settings[row.key] = JSON.parse(row.value);
            } catch (e) {
                settings[row.key] = row.value;
            }
        }
        return settings;
    },

    /**
     * Check if a setting exists
     */
    has(key) {
        const row = getDb().prepare('SELECT 1 FROM settings WHERE key = ?').get(key);
        return !!row;
    },
};

module.exports = SettingsRepository;
