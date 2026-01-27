/**
 * Admin Logs Routes
 * Handles system logs viewing and streaming
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { query, validationResult } = require('express-validator');
const logger = require('../../../utils/logger');

/**
 * Validation error handler
 */
const handleValidationErrors = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ error: 'Validation failed', details: errors.array() });
    }
    next();
};

/**
 * GET /logs
 * Get system logs
 */
router.get('/', [
    query('lines').optional().isInt({ min: 1, max: 5000 }),
    query('file').optional().isIn(['output', 'error', 'asterisk', 'install']),
    handleValidationErrors,
], async (req, res) => {
    try {
        const lines = parseInt(req.query.lines) || 100;
        const file = req.query.file || 'output';

        // Define log file paths
        const logDir = process.env.LOG_DIR || '/var/log/homenichat';
        const logFiles = {
            output: path.join(logDir, 'output.log'),
            error: path.join(logDir, 'error.log'),
            asterisk: '/var/log/asterisk/messages',
            install: '/var/log/homenichat-install.log',
        };

        const logPath = logFiles[file];

        if (!logPath || !fs.existsSync(logPath)) {
            return res.json({
                file,
                lines: [],
                message: `Log file not found: ${logPath}`,
            });
        }

        // Read last N lines using tail-like approach
        const content = fs.readFileSync(logPath, 'utf8');
        const allLines = content.split('\n').filter(l => l.trim());
        const lastLines = allLines.slice(-lines);

        res.json({
            file,
            path: logPath,
            total: allLines.length,
            returned: lastLines.length,
            lines: lastLines,
        });
    } catch (error) {
        logger.error('[Admin/Logs] Error getting logs:', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /logs/stream
 * Stream logs via SSE (Server-Sent Events)
 */
router.get('/stream', [
    query('file').optional().isIn(['output', 'error', 'asterisk']),
], async (req, res) => {
    const file = req.query.file || 'output';
    const logDir = process.env.LOG_DIR || '/var/log/homenichat';

    const logFiles = {
        output: path.join(logDir, 'output.log'),
        error: path.join(logDir, 'error.log'),
        asterisk: '/var/log/asterisk/messages',
    };

    const logPath = logFiles[file];

    if (!logPath || !fs.existsSync(logPath)) {
        return res.status(404).json({ error: 'Log file not found' });
    }

    // Setup SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Watch file for changes
    let lastSize = 0;
    const watcher = fs.watch(logPath, (eventType) => {
        if (eventType === 'change') {
            try {
                const stats = fs.statSync(logPath);
                if (stats.size > lastSize) {
                    const fd = fs.openSync(logPath, 'r');
                    const buffer = Buffer.alloc(stats.size - lastSize);
                    fs.readSync(fd, buffer, 0, buffer.length, lastSize);
                    fs.closeSync(fd);

                    const newContent = buffer.toString('utf8');
                    const newLines = newContent.split('\n').filter(l => l.trim());

                    newLines.forEach(line => {
                        res.write(`data: ${JSON.stringify({ line })}\n\n`);
                    });

                    lastSize = stats.size;
                }
            } catch (err) {
                logger.error('[Admin/Logs] Error streaming logs:', err);
            }
        }
    });

    // Send initial size
    try {
        const stats = fs.statSync(logPath);
        lastSize = stats.size;
    } catch (err) {
        // Ignore
    }

    // Cleanup on disconnect
    req.on('close', () => {
        watcher.close();
    });
});

/**
 * GET /logs/files
 * List available log files
 */
router.get('/files', async (req, res) => {
    try {
        const logDir = process.env.LOG_DIR || '/var/log/homenichat';
        const files = [];

        const logFiles = {
            output: path.join(logDir, 'output.log'),
            error: path.join(logDir, 'error.log'),
            asterisk: '/var/log/asterisk/messages',
            install: '/var/log/homenichat-install.log',
        };

        for (const [name, filePath] of Object.entries(logFiles)) {
            try {
                const stats = fs.statSync(filePath);
                files.push({
                    name,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime,
                    exists: true,
                });
            } catch (err) {
                files.push({
                    name,
                    path: filePath,
                    exists: false,
                });
            }
        }

        res.json({ files });
    } catch (error) {
        logger.error('[Admin/Logs] Error listing log files:', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
