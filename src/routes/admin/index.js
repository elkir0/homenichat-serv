/**
 * Admin Routes - Main Router
 * Combines all admin sub-routers into a single module
 *
 * Refactored from monolithic routes/admin.js (3692 lines)
 * into logical modules for better maintainability
 */

const express = require('express');
const router = express.Router();

// Import sub-routers
const dashboardRouter = require('./dashboard');
const providersRouter = require('./providers');
const modemsRouter = require('./modems');
const voipRouter = require('./voip');
const usersRouter = require('./users');
const settingsRouter = require('./settings');
const whatsappRouter = require('./whatsapp');
const pushRelayRouter = require('./push-relay');
const tunnelRelayRouter = require('./tunnel-relay');
const cloudRouter = require('./cloud');
const systemRouter = require('./system');
const installRouter = require('./install');
const logsRouter = require('./logs');
const securityRouter = require('./security');

// =============================================================================
// CORE ROUTES
// =============================================================================

router.use('/dashboard', dashboardRouter);
router.use('/providers', providersRouter);
router.use('/modems', modemsRouter);
router.use('/voip', voipRouter);
router.use('/users', usersRouter);
router.use('/config', settingsRouter);

// =============================================================================
// COMMUNICATION ROUTES
// =============================================================================

router.use('/whatsapp', whatsappRouter);
router.use('/push-relay', pushRelayRouter);
router.use('/tunnel-relay', tunnelRelayRouter);
router.use('/homenichat-cloud', cloudRouter);

// =============================================================================
// SYSTEM ROUTES
// =============================================================================

router.use('/system', systemRouter);
router.use('/install', installRouter);
router.use('/logs', logsRouter);

// =============================================================================
// SECURITY ROUTES (mounted at root for /audit-log, /active-sessions, /api-tokens)
// =============================================================================

router.use('/', securityRouter);

// =============================================================================
// LEGACY ROUTE MAPPINGS FOR BACKWARD COMPATIBILITY
// =============================================================================

// Modem mappings are now under /modems/mappings/*
router.use('/modem-mappings', (req, res, next) => {
    req.url = '/mappings' + req.url;
    modemsRouter(req, res, next);
});

// Device tokens are now under /modems/device-tokens/*
router.use('/device-tokens', (req, res, next) => {
    req.url = '/device-tokens' + req.url;
    modemsRouter(req, res, next);
});

// SMS stats
router.get('/sms/stats', (req, res, next) => {
    req.url = '/sms/stats';
    modemsRouter(req, res, next);
});

module.exports = router;
