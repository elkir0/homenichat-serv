/**
 * Setup Middleware - Redirect to setup wizard if not complete
 *
 * This middleware checks if the initial setup has been completed.
 * If not, it redirects admin UI requests to /admin/setup.
 *
 * API requests to /api/setup/* are always allowed.
 * Other API requests are allowed (apps may not need setup wizard).
 */

const db = require('../services/DatabaseService');

/**
 * Middleware that redirects to setup wizard if setup is not complete
 *
 * @param {Object} options
 * @param {boolean} options.apiMode - If true, returns JSON instead of redirect
 */
function setupRequiredMiddleware(options = {}) {
    return (req, res, next) => {
        // Always allow setup API routes
        if (req.path.startsWith('/api/setup')) {
            return next();
        }

        // Check if setup is complete
        const isComplete = db.isSetupComplete();

        if (isComplete) {
            // Setup is complete, proceed normally
            return next();
        }

        // Setup is NOT complete

        // For API requests, return JSON indicating setup is needed
        if (req.path.startsWith('/api/')) {
            // Allow auth routes (needed for setup wizard login)
            if (req.path.startsWith('/api/auth')) {
                return next();
            }

            // For other API routes, indicate setup is needed
            if (options.apiMode) {
                return res.status(503).json({
                    error: 'Setup required',
                    setupNeeded: true,
                    setupUrl: '/admin/setup',
                    message: 'Initial server setup has not been completed. Please complete the setup wizard first.'
                });
            }

            // Allow API access (some clients may work without full setup)
            return next();
        }

        // For admin UI requests, redirect to setup wizard
        if (req.path.startsWith('/admin')) {
            // Already on setup page
            if (req.path.startsWith('/admin/setup')) {
                return next();
            }

            // Allow static assets
            if (req.path.match(/\.(js|css|png|jpg|svg|ico|woff|woff2|ttf)$/)) {
                return next();
            }

            // Redirect to setup wizard
            // For SPA, we just serve the admin index.html and let the frontend handle routing
            // But we can add a header to indicate setup is needed
            res.set('X-Setup-Required', 'true');
            return next();
        }

        // For other routes, proceed normally
        next();
    };
}

/**
 * API endpoint to check setup status (used by frontend)
 */
function getSetupStatusEndpoint(req, res) {
    const isComplete = db.isSetupComplete();
    const currentStep = db.getCurrentSetupStep();
    const adminPasswordChanged = db.isAdminPasswordChanged();

    res.json({
        setupNeeded: !isComplete,
        setupComplete: isComplete,
        currentStep,
        adminPasswordChanged,
        redirectTo: isComplete ? null : '/admin/setup'
    });
}

module.exports = {
    setupRequiredMiddleware,
    getSetupStatusEndpoint
};
