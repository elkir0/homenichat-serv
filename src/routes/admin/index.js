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

// Mount sub-routers
router.use('/dashboard', dashboardRouter);
router.use('/providers', providersRouter);
router.use('/modems', modemsRouter);
router.use('/voip', voipRouter);
router.use('/users', usersRouter);
router.use('/config', settingsRouter);

// Legacy aliases for backward compatibility
router.use('/whatsapp', providersRouter);

module.exports = router;
