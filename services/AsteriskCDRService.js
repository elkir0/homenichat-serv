/**
 * AsteriskCDRService.js
 * Service pour accéder aux CDR (Call Detail Records) depuis la base MySQL Asterisk/FreePBX
 *
 * Compatible avec la table `cdr` de asteriskcdrdb
 */

const mysql = require('mysql2/promise');
const logger = require('../utils/logger');

class AsteriskCDRService {
  constructor() {
    this.pool = null;
    this.config = null;
    this.connected = false;
  }

  /**
   * Configurer et créer le pool de connexions MySQL
   * @param {Object} config - Configuration MySQL
   */
  async configure(config) {
    this.config = {
      host: config.host || process.env.ASTERISK_CDR_HOST || 'localhost',
      port: config.port || process.env.ASTERISK_CDR_PORT || 3306,
      user: config.user || process.env.ASTERISK_CDR_USER || 'freepbxuser',
      password: config.password || process.env.ASTERISK_CDR_PASSWORD || '',
      database: config.database || process.env.ASTERISK_CDR_DATABASE || 'asteriskcdrdb',
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    };

    try {
      // Fermer l'ancien pool si existant
      if (this.pool) {
        await this.pool.end();
      }

      this.pool = mysql.createPool(this.config);

      // Tester la connexion
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      this.connected = true;
      logger.info(`[AsteriskCDR] Connected to MySQL ${this.config.host}:${this.config.port}/${this.config.database}`);

      return { success: true };
    } catch (error) {
      this.connected = false;
      logger.error(`[AsteriskCDR] Connection failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Vérifier l'état de la connexion
   */
  async getStatus() {
    if (!this.pool) {
      return { connected: false, error: 'Not configured' };
    }

    try {
      const connection = await this.pool.getConnection();
      await connection.ping();

      // Compter les enregistrements
      const [rows] = await connection.query('SELECT COUNT(*) as count FROM cdr');
      connection.release();

      return {
        connected: true,
        host: this.config.host,
        database: this.config.database,
        totalRecords: rows[0].count
      };
    } catch (error) {
      this.connected = false;
      return { connected: false, error: error.message };
    }
  }

  /**
   * Déterminer la direction d'un appel
   */
  _determineDirection(src, dst, dcontext, channel) {
    // Appels sortants via trunk GSM
    if (channel && (channel.includes('PJSIP/GSM') || channel.includes('SIP/GSM'))) {
      if (dst && dst.length >= 10) {
        return 'outbound';
      }
    }

    // Appels sortants via contexte
    if (dcontext && (dcontext.includes('from-internal') || dcontext.includes('outbound') || dcontext.includes('outrt'))) {
      if (dst && dst.length >= 10) {
        return 'outbound';
      }
    }

    // Appels entrants
    if (dcontext && (dcontext.includes('from-trunk') || dcontext.includes('from-pstn') || dcontext.includes('from-did'))) {
      return 'inbound';
    }

    // Appels internes (entre extensions courtes)
    if (src && dst && /^\d{1,4}$/.test(src) && /^\d{1,4}$/.test(dst)) {
      return 'internal';
    }

    // Par défaut, regarder la longueur de dst
    if (dst && dst.length >= 10) {
      return 'outbound';
    }

    return 'inbound';
  }

  /**
   * Extraire l'extension d'un channel (ex: PJSIP/1001-0000005b -> 1001)
   */
  _extractExtension(channel) {
    if (!channel) return '';
    const match = channel.match(/(?:PJSIP|SIP)\/(\d+)-/);
    return match ? match[1] : '';
  }

  /**
   * Extraire le trunk d'un channel (ex: PJSIP/GSM-Chiro-00000059 -> GSM-Chiro)
   */
  _extractTrunk(channel) {
    if (!channel) return '';
    const match = channel.match(/(?:PJSIP|SIP)\/([A-Za-z][\w-]*)-[0-9a-f]+$/i);
    return match ? match[1] : '';
  }

  /**
   * Formater un enregistrement CDR
   */
  _formatRecord(row) {
    const direction = this._determineDirection(
      row.src,
      row.dst,
      row.dcontext,
      row.channel
    );

    const answeredByExt = this._extractExtension(row.dstchannel);
    const trunkIn = this._extractTrunk(row.channel);
    const trunkOut = this._extractTrunk(row.dstchannel);
    const trunk = trunkIn || trunkOut;

    const duration = row.duration || 0;
    const billsec = row.billsec || 0;
    const ringTime = duration - billsec;

    let answeredAt = null;
    if (billsec > 0 && row.calldate) {
      const callDate = new Date(row.calldate);
      answeredAt = new Date(callDate.getTime() + ringTime * 1000).toISOString();
    }

    return {
      id: row.uniqueid,
      calldate: row.calldate ? new Date(row.calldate).toISOString() : null,
      caller_id: row.clid || '',
      caller_name: row.cnam || '',
      caller_number: row.cnum || row.src || '',
      src: row.src || '',
      dst: row.dst || '',
      did: row.did || '',
      duration: duration,
      billsec: billsec,
      ring_time: ringTime,
      disposition: row.disposition || '',
      direction: direction,
      trunk: trunk,
      answered_by_extension: answeredByExt,
      answered_by_name: row.dst_cnam || '',
      answered_at: answeredAt,
      recording_file: row.recordingfile || '',
      uniqueid: row.uniqueid || '',
      linkedid: row.linkedid || '',
      accountcode: row.accountcode || '',
      channel: row.channel || '',
      dstchannel: row.dstchannel || ''
    };
  }

  /**
   * Lister les appels avec filtres et pagination
   */
  async listCalls(options = {}) {
    if (!this.pool) {
      throw new Error('AsteriskCDR not configured');
    }

    const {
      limit = 50,
      offset = 0,
      direction = null,
      disposition = null,
      src = null,
      dst = null,
      did = null,
      dateFrom = null,
      dateTo = null,
      search = null,
      extensions = null // Filtrer par extensions (array)
    } = options;

    const connection = await this.pool.getConnection();

    try {
      // Build WHERE clause
      let whereClauses = ['1=1'];
      let params = [];

      if (disposition) {
        whereClauses.push('disposition = ?');
        params.push(disposition);
      }

      if (src) {
        whereClauses.push('src LIKE ?');
        params.push(`%${src}%`);
      }

      if (dst) {
        whereClauses.push('dst LIKE ?');
        params.push(`%${dst}%`);
      }

      if (did) {
        whereClauses.push('did LIKE ?');
        params.push(`%${did}%`);
      }

      if (dateFrom) {
        whereClauses.push('calldate >= ?');
        params.push(`${dateFrom} 00:00:00`);
      }

      if (dateTo) {
        whereClauses.push('calldate <= ?');
        params.push(`${dateTo} 23:59:59`);
      }

      if (search) {
        whereClauses.push('(src LIKE ? OR dst LIKE ? OR clid LIKE ?)');
        params.push(`%${search}%`, `%${search}%`, `%${search}%`);
      }

      // Filtrer par extensions (appels où src OU dst est une extension listée)
      if (extensions && extensions.length > 0) {
        const extPlaceholders = extensions.map(() => '?').join(',');
        whereClauses.push(`(src IN (${extPlaceholders}) OR dst IN (${extPlaceholders}))`);
        params.push(...extensions, ...extensions);
      }

      const whereClause = whereClauses.join(' AND ');

      // Count total
      const [countRows] = await connection.query(
        `SELECT COUNT(*) as total FROM cdr WHERE ${whereClause}`,
        params
      );
      const total = countRows[0].total;

      // Get records
      const query = `
        SELECT calldate, clid, src, dst, dcontext, channel, dstchannel,
               duration, billsec, disposition, did, recordingfile,
               uniqueid, linkedid, accountcode, cnum, cnam, dst_cnam
        FROM cdr
        WHERE ${whereClause}
        ORDER BY calldate DESC
        LIMIT ? OFFSET ?
      `;

      const [rows] = await connection.query(query, [...params, parseInt(limit), parseInt(offset)]);

      // Format and filter by direction (post-processing)
      let calls = rows.map(row => this._formatRecord(row));

      if (direction && direction !== 'all') {
        calls = calls.filter(call => call.direction === direction);
      }

      // Summary stats
      const [summaryRows] = await connection.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN disposition = 'ANSWERED' THEN 1 ELSE 0 END) as answered,
          SUM(CASE WHEN disposition = 'NO ANSWER' THEN 1 ELSE 0 END) as no_answer,
          SUM(duration) as total_duration,
          AVG(CASE WHEN disposition = 'ANSWERED' THEN billsec ELSE NULL END) as avg_duration
        FROM cdr WHERE ${whereClause}
      `, params);

      const summary = summaryRows[0];

      return {
        calls,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          has_more: offset + limit < total
        },
        summary: {
          total_calls: summary.total || 0,
          answered: summary.answered || 0,
          no_answer: summary.no_answer || 0,
          total_duration_seconds: summary.total_duration || 0,
          average_duration_seconds: Math.round((summary.avg_duration || 0) * 10) / 10
        }
      };
    } finally {
      connection.release();
    }
  }

  /**
   * Récupérer un appel par son uniqueid
   */
  async getCall(callId) {
    if (!this.pool) {
      throw new Error('AsteriskCDR not configured');
    }

    const connection = await this.pool.getConnection();

    try {
      const [rows] = await connection.query(`
        SELECT calldate, clid, src, dst, dcontext, channel, dstchannel,
               duration, billsec, disposition, did, recordingfile,
               uniqueid, linkedid, accountcode, cnum, cnam, dst_cnam,
               lastapp, lastdata, amaflags, userfield
        FROM cdr
        WHERE uniqueid = ?
      `, [callId]);

      if (rows.length === 0) {
        return null;
      }

      const record = this._formatRecord(rows[0]);
      record.lastapp = rows[0].lastapp;
      record.lastdata = rows[0].lastdata;
      record.amaflags = rows[0].amaflags;
      record.userfield = rows[0].userfield;

      return record;
    } finally {
      connection.release();
    }
  }

  /**
   * Statistiques d'appels
   */
  async getStats(options = {}) {
    if (!this.pool) {
      throw new Error('AsteriskCDR not configured');
    }

    const {
      period = 'today',
      dateFrom = null,
      dateTo = null
    } = options;

    const connection = await this.pool.getConnection();

    try {
      const now = new Date();
      let startDate, endDate;

      if (dateFrom && dateTo) {
        startDate = dateFrom;
        endDate = dateTo;
      } else {
        switch (period) {
          case 'today':
            startDate = now.toISOString().split('T')[0];
            endDate = startDate;
            break;
          case 'yesterday':
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            startDate = yesterday.toISOString().split('T')[0];
            endDate = startDate;
            break;
          case 'week':
            const weekAgo = new Date(now);
            weekAgo.setDate(weekAgo.getDate() - 7);
            startDate = weekAgo.toISOString().split('T')[0];
            endDate = now.toISOString().split('T')[0];
            break;
          case 'month':
            const monthAgo = new Date(now);
            monthAgo.setDate(monthAgo.getDate() - 30);
            startDate = monthAgo.toISOString().split('T')[0];
            endDate = now.toISOString().split('T')[0];
            break;
          case 'year':
            const yearAgo = new Date(now);
            yearAgo.setFullYear(yearAgo.getFullYear() - 1);
            startDate = yearAgo.toISOString().split('T')[0];
            endDate = now.toISOString().split('T')[0];
            break;
          default: // all
            startDate = '2000-01-01';
            endDate = now.toISOString().split('T')[0];
        }
      }

      // Global stats
      const [statsRows] = await connection.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN disposition = 'ANSWERED' THEN 1 ELSE 0 END) as answered,
          SUM(CASE WHEN disposition = 'NO ANSWER' THEN 1 ELSE 0 END) as no_answer,
          SUM(CASE WHEN disposition = 'BUSY' THEN 1 ELSE 0 END) as busy,
          SUM(CASE WHEN disposition = 'FAILED' THEN 1 ELSE 0 END) as failed,
          SUM(duration) as total_duration,
          SUM(billsec) as total_billsec,
          AVG(CASE WHEN disposition = 'ANSWERED' THEN billsec ELSE NULL END) as avg_duration,
          MIN(calldate) as first_call,
          MAX(calldate) as last_call
        FROM cdr
        WHERE calldate >= ? AND calldate <= ?
      `, [`${startDate} 00:00:00`, `${endDate} 23:59:59`]);

      const stats = statsRows[0];

      // Hourly stats for today/yesterday
      let hourlyStats = [];
      if (period === 'today' || period === 'yesterday') {
        const [hourlyRows] = await connection.query(`
          SELECT
            HOUR(calldate) as hour,
            COUNT(*) as calls,
            SUM(CASE WHEN disposition = 'ANSWERED' THEN 1 ELSE 0 END) as answered
          FROM cdr
          WHERE DATE(calldate) = ?
          GROUP BY HOUR(calldate)
          ORDER BY hour
        `, [startDate]);

        hourlyStats = hourlyRows.map(row => ({
          hour: row.hour,
          calls: row.calls,
          answered: row.answered
        }));
      }

      // Top sources
      const [topSourcesRows] = await connection.query(`
        SELECT src, COUNT(*) as calls
        FROM cdr
        WHERE calldate >= ? AND calldate <= ? AND src != ''
        GROUP BY src
        ORDER BY calls DESC
        LIMIT 10
      `, [`${startDate} 00:00:00`, `${endDate} 23:59:59`]);

      // Top destinations
      const [topDestsRows] = await connection.query(`
        SELECT dst, COUNT(*) as calls
        FROM cdr
        WHERE calldate >= ? AND calldate <= ? AND dst != '' AND dst != 's'
        GROUP BY dst
        ORDER BY calls DESC
        LIMIT 10
      `, [`${startDate} 00:00:00`, `${endDate} 23:59:59`]);

      const totalDuration = stats.total_duration || 0;
      const hours = Math.floor(totalDuration / 3600);
      const minutes = Math.floor((totalDuration % 3600) / 60);

      return {
        period: {
          name: period,
          from: startDate,
          to: endDate
        },
        totals: {
          calls: stats.total || 0,
          answered: stats.answered || 0,
          no_answer: stats.no_answer || 0,
          busy: stats.busy || 0,
          failed: stats.failed || 0,
          answer_rate: Math.round(((stats.answered || 0) / (stats.total || 1)) * 1000) / 10
        },
        duration: {
          total_seconds: totalDuration,
          billable_seconds: stats.total_billsec || 0,
          average_seconds: Math.round((stats.avg_duration || 0) * 10) / 10,
          total_formatted: `${hours}h ${minutes}m`
        },
        timeline: {
          first_call: stats.first_call ? new Date(stats.first_call).toISOString() : null,
          last_call: stats.last_call ? new Date(stats.last_call).toISOString() : null
        },
        hourly: hourlyStats,
        top_sources: topSourcesRows.map(r => ({ number: r.src, calls: r.calls })),
        top_destinations: topDestsRows.map(r => ({ number: r.dst, calls: r.calls }))
      };
    } finally {
      connection.release();
    }
  }

  /**
   * Lister les extensions actives (derniers 30 jours)
   */
  async listExtensions() {
    if (!this.pool) {
      throw new Error('AsteriskCDR not configured');
    }

    const connection = await this.pool.getConnection();

    try {
      const [rows] = await connection.query(`
        SELECT
          src as extension,
          COUNT(*) as total_calls,
          SUM(CASE WHEN disposition = 'ANSWERED' THEN 1 ELSE 0 END) as answered,
          SUM(billsec) as total_duration,
          MAX(calldate) as last_call
        FROM cdr
        WHERE src REGEXP '^[0-9]{1,4}$'
          AND calldate >= DATE_SUB(NOW(), INTERVAL 30 DAY)
        GROUP BY src
        ORDER BY total_calls DESC
      `);

      return rows.map(row => ({
        extension: row.extension,
        total_calls: row.total_calls,
        answered_calls: row.answered,
        total_duration_seconds: row.total_duration || 0,
        last_call: row.last_call ? new Date(row.last_call).toISOString() : null
      }));
    } finally {
      connection.release();
    }
  }

  /**
   * Récupérer les infos d'enregistrement d'un appel
   */
  async getRecordingInfo(callId) {
    if (!this.pool) {
      throw new Error('AsteriskCDR not configured');
    }

    const connection = await this.pool.getConnection();

    try {
      const [rows] = await connection.query(`
        SELECT uniqueid, calldate, recordingfile
        FROM cdr
        WHERE uniqueid = ? AND recordingfile != ''
      `, [callId]);

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      const recordingPath = row.recordingfile;

      return {
        call_id: row.uniqueid,
        calldate: row.calldate ? new Date(row.calldate).toISOString() : null,
        recording_file: recordingPath,
        recording_path: recordingPath ? `/var/spool/asterisk/monitor/${recordingPath}` : null,
        download_url: recordingPath ? `/api/cdr/v1/recordings/${row.uniqueid}/download` : null
      };
    } finally {
      connection.release();
    }
  }

  /**
   * Fermer les connexions
   */
  async close() {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      this.connected = false;
      logger.info('[AsteriskCDR] Connection pool closed');
    }
  }
}

// Singleton instance
const asteriskCDRService = new AsteriskCDRService();

module.exports = asteriskCDRService;
