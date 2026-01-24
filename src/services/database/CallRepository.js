/**
 * Call Repository
 * Handles call history operations
 */

const getDb = () => require('./index').db;

const CallRepository = {
    /**
     * Create a new call record
     */
    create(call) {
        const stmt = getDb().prepare(`
            INSERT INTO call_history (
                id, direction, caller_number, called_number, caller_name,
                start_time, answer_time, end_time, duration,
                answered_by_user_id, answered_by_username, answered_by_extension,
                status, source, pbx_call_id, seen, notes, recording_url, line_name, device_name, raw_data
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            call.id,
            call.direction,
            call.callerNumber,
            call.calledNumber,
            call.callerName || null,
            call.startTime,
            call.answerTime || null,
            call.endTime || null,
            call.duration || 0,
            call.answeredByUserId || null,
            call.answeredByUsername || null,
            call.answeredByExtension || null,
            call.status,
            call.source || 'pwa',
            call.pbxCallId || null,
            call.seen ? 1 : 0,
            call.notes || null,
            call.recordingUrl || null,
            call.lineName || null,
            call.deviceName || null,
            call.rawData ? JSON.stringify(call.rawData) : null
        );
        return call;
    },

    /**
     * Update a call record
     */
    update(id, updates) {
        const fields = [];
        const values = [];

        const fieldMap = {
            answerTime: 'answer_time',
            endTime: 'end_time',
            duration: 'duration',
            answeredByUserId: 'answered_by_user_id',
            answeredByUsername: 'answered_by_username',
            answeredByExtension: 'answered_by_extension',
            status: 'status',
            notes: 'notes',
            recordingUrl: 'recording_url',
        };

        for (const [key, column] of Object.entries(fieldMap)) {
            if (updates[key] !== undefined) {
                fields.push(`${column} = ?`);
                values.push(updates[key]);
            }
        }

        if (updates.seen !== undefined) {
            fields.push('seen = ?');
            values.push(updates.seen ? 1 : 0);
        }

        if (fields.length === 0) return null;

        values.push(id);
        const sql = `UPDATE call_history SET ${fields.join(', ')} WHERE id = ?`;
        getDb().prepare(sql).run(...values);
        return this.findById(id);
    },

    /**
     * Find call by ID
     */
    findById(id) {
        const row = getDb().prepare('SELECT * FROM call_history WHERE id = ?').get(id);
        return row ? this._formatRow(row) : null;
    },

    /**
     * Find call by PBX ID
     */
    findByPbxId(pbxCallId) {
        const row = getDb().prepare('SELECT * FROM call_history WHERE pbx_call_id = ?').get(pbxCallId);
        return row ? this._formatRow(row) : null;
    },

    /**
     * Get call history with filters
     */
    findAll({ limit = 50, offset = 0, status = null, direction = null, before = null, after = null } = {}) {
        let sql = 'SELECT * FROM call_history WHERE 1=1';
        const params = [];

        if (status) {
            sql += ' AND status = ?';
            params.push(status);
        }
        if (direction) {
            sql += ' AND direction = ?';
            params.push(direction);
        }
        if (before) {
            sql += ' AND start_time < ?';
            params.push(before);
        }
        if (after) {
            sql += ' AND start_time > ?';
            params.push(after);
        }

        sql += ' ORDER BY start_time DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const rows = getDb().prepare(sql).all(...params);
        return rows.map(row => this._formatRow(row));
    },

    /**
     * Count missed calls
     */
    countMissed() {
        const row = getDb().prepare(
            "SELECT COUNT(*) as count FROM call_history WHERE status = 'missed' AND seen = 0"
        ).get();
        return row?.count || 0;
    },

    /**
     * Mark all missed calls as seen
     */
    markAllMissedAsSeen() {
        return getDb().prepare(
            "UPDATE call_history SET seen = 1 WHERE status = 'missed' AND seen = 0"
        ).run();
    },

    /**
     * Get call statistics
     */
    getStats({ days = 30 } = {}) {
        const since = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60);

        const stats = getDb().prepare(`
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'answered' THEN 1 ELSE 0 END) as answered,
                SUM(CASE WHEN status = 'missed' THEN 1 ELSE 0 END) as missed,
                SUM(CASE WHEN direction = 'incoming' THEN 1 ELSE 0 END) as incoming,
                SUM(CASE WHEN direction = 'outgoing' THEN 1 ELSE 0 END) as outgoing,
                AVG(CASE WHEN duration > 0 THEN duration ELSE NULL END) as avg_duration,
                SUM(duration) as total_duration
            FROM call_history
            WHERE start_time > ?
        `).get(since);

        return {
            total: stats.total || 0,
            answered: stats.answered || 0,
            missed: stats.missed || 0,
            incoming: stats.incoming || 0,
            outgoing: stats.outgoing || 0,
            avgDuration: Math.round(stats.avg_duration || 0),
            totalDuration: stats.total_duration || 0,
        };
    },

    /**
     * Purge old calls
     */
    purgeOld(daysToKeep = 90) {
        const cutoff = Math.floor(Date.now() / 1000) - (daysToKeep * 24 * 60 * 60);
        const result = getDb().prepare('DELETE FROM call_history WHERE start_time < ?').run(cutoff);
        return result.changes;
    },

    /**
     * Format database row to JS object
     */
    _formatRow(row) {
        return {
            id: row.id,
            direction: row.direction,
            callerNumber: row.caller_number,
            calledNumber: row.called_number,
            callerName: row.caller_name,
            lineName: row.line_name,
            deviceName: row.device_name,
            startTime: row.start_time,
            answerTime: row.answer_time,
            endTime: row.end_time,
            duration: row.duration,
            answeredByUserId: row.answered_by_user_id,
            answeredByUsername: row.answered_by_username,
            answeredByExtension: row.answered_by_extension,
            status: row.status,
            source: row.source,
            pbxCallId: row.pbx_call_id,
            seen: !!row.seen,
            notes: row.notes,
            recordingUrl: row.recording_url,
            rawData: row.raw_data ? JSON.parse(row.raw_data) : null,
            createdAt: row.created_at,
        };
    },
};

module.exports = CallRepository;
