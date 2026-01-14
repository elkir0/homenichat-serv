const express = require('express');
const { body, query, validationResult } = require('express-validator');
const db = require('../services/DatabaseService');
const { verifyToken, isAdmin } = require('../middleware/auth');
const pushService = require('../services/PushService');
const freepbxAmi = require('../services/FreePBXAmiService');

const router = express.Router();

// ========================================
// LIVE CALL CONTROL (AMI)
// ========================================

/**
 * GET /api/calls/ringing
 * Get list of currently ringing calls
 */
router.get('/ringing', verifyToken, (req, res) => {
    try {
        const ringingCalls = freepbxAmi.getRingingCalls();
        res.json({ calls: ringingCalls });
    } catch (error) {
        console.error('Erreur GET /api/calls/ringing:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération des appels' });
    }
});

/**
 * POST /api/calls/ringing/:callId/answer
 * Answer a ringing call by redirecting it to the user's WebRTC extension
 */
router.post('/ringing/:callId/answer', verifyToken, [
    body('extension').optional().isString()
], async (req, res) => {
    try {
        const { callId } = req.params;
        // Use the extension from request body, or default to configured WebRTC extension
        const targetExtension = req.body.extension || process.env.VOIP_USER || '200';

        console.log(`[API] Answer call ${callId} -> extension ${targetExtension} (user: ${req.user.username})`);

        const result = await freepbxAmi.answerCall(callId, targetExtension);

        if (result.success) {
            // Update the call in DB as answered by this user
            const existingCall = db.getCallByPbxId(callId);
            if (existingCall) {
                db.updateCall(existingCall.id, {
                    status: 'answered',
                    answerTime: Math.floor(Date.now() / 1000),
                    answeredByUserId: req.user.id,
                    answeredByUsername: req.user.username,
                    answeredByExtension: targetExtension
                });
            }

            res.json({ success: true, message: result.message, extension: targetExtension });
        } else {
            res.status(400).json({ success: false, error: result.message });
        }
    } catch (error) {
        console.error('Erreur POST /api/calls/ringing/:callId/answer:', error);
        res.status(500).json({ error: 'Erreur lors de la réponse à l\'appel' });
    }
});

/**
 * POST /api/calls/ringing/:callId/reject
 * Reject a ringing call
 */
router.post('/ringing/:callId/reject', verifyToken, async (req, res) => {
    try {
        const { callId } = req.params;

        console.log(`[API] Reject call ${callId} (user: ${req.user.username})`);

        const result = await freepbxAmi.rejectCall(callId);

        if (result.success) {
            res.json({ success: true, message: result.message });
        } else {
            res.status(400).json({ success: false, error: result.message });
        }
    } catch (error) {
        console.error('Erreur POST /api/calls/ringing/:callId/reject:', error);
        res.status(500).json({ error: 'Erreur lors du rejet de l\'appel' });
    }
});

/**
 * GET /api/calls/ami/status
 * Get AMI connection status
 */
router.get('/ami/status', verifyToken, (req, res) => {
    try {
        const status = freepbxAmi.getStatus();
        res.json(status);
    } catch (error) {
        console.error('Erreur GET /api/calls/ami/status:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération du statut AMI' });
    }
});

// ========================================
// CALL HISTORY
// ========================================

/**
 * GET /api/calls
 * Récupérer l'historique des appels (paginé)
 * Accessible à tous les utilisateurs authentifiés
 */
router.get('/', verifyToken, [
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
    query('status').optional().isIn(['missed', 'answered', 'rejected', 'busy', 'failed']),
    query('direction').optional().isIn(['incoming', 'outgoing'])
], (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const { limit = 50, offset = 0, status, direction, before, after } = req.query;

        const calls = db.getCallHistory({
            limit: parseInt(limit),
            offset: parseInt(offset),
            status,
            direction,
            before: before ? parseInt(before) : null,
            after: after ? parseInt(after) : null
        });

        res.json({
            calls,
            pagination: {
                limit: parseInt(limit),
                offset: parseInt(offset),
                hasMore: calls.length === parseInt(limit)
            }
        });
    } catch (error) {
        console.error('Erreur GET /api/calls:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération de l\'historique' });
    }
});

/**
 * GET /api/calls/missed/count
 * Compter les appels manqués non vus
 */
router.get('/missed/count', verifyToken, (req, res) => {
    try {
        const count = db.getMissedCallsCount();
        res.json({ count });
    } catch (error) {
        console.error('Erreur GET /api/calls/missed/count:', error);
        res.status(500).json({ error: 'Erreur lors du comptage' });
    }
});

/**
 * GET /api/calls/stats
 * Statistiques des appels (ADMIN ONLY)
 */
router.get('/stats', verifyToken, isAdmin, [
    query('days').optional().isInt({ min: 1, max: 365 })
], (req, res) => {
    try {
        const { days = 30 } = req.query;
        const stats = db.getCallStats({ days: parseInt(days) });
        res.json(stats);
    } catch (error) {
        console.error('Erreur GET /api/calls/stats:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération des statistiques' });
    }
});

/**
 * GET /api/calls/:id
 * Récupérer les détails d'un appel
 */
router.get('/:id', verifyToken, (req, res) => {
    try {
        const call = db.getCallById(req.params.id);
        if (!call) {
            return res.status(404).json({ error: 'Appel non trouvé' });
        }
        res.json(call);
    } catch (error) {
        console.error('Erreur GET /api/calls/:id:', error);
        res.status(500).json({ error: 'Erreur lors de la récupération de l\'appel' });
    }
});

/**
 * POST /api/calls
 * Enregistrer un nouvel appel
 */
router.post('/', verifyToken, [
    body('id').notEmpty(),
    body('direction').isIn(['incoming', 'outgoing']),
    body('callerNumber').notEmpty(),
    body('calledNumber').notEmpty(),
    body('startTime').isInt(),
    body('status').isIn(['ringing', 'missed', 'answered', 'rejected', 'busy', 'failed'])
], (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ errors: errors.array() });
        }

        const callData = {
            id: req.body.id,
            direction: req.body.direction,
            callerNumber: req.body.callerNumber,
            calledNumber: req.body.calledNumber,
            callerName: req.body.callerName || null,
            startTime: req.body.startTime,
            answerTime: req.body.answerTime || null,
            endTime: req.body.endTime || null,
            duration: req.body.duration || 0,
            answeredByUserId: req.body.answeredByUserId || null,
            answeredByUsername: req.body.answeredByUsername || null,
            answeredByExtension: req.body.answeredByExtension || null,
            status: req.body.status,
            source: req.body.source || 'pwa',
            pbxCallId: req.body.pbxCallId || null,
            rawData: req.body.rawData || null
        };

        // Vérifier si l'appel existe déjà (par id ou pbx_call_id)
        const existing = db.getCallById(callData.id);
        if (existing) {
            return res.status(409).json({ error: 'Appel déjà enregistré', call: existing });
        }

        const call = db.createCall(callData);

        // Broadcaster à tous les clients connectés
        if (pushService && pushService.broadcast) {
            pushService.broadcast('CALL_CREATED', call);
        }

        res.status(201).json(call);
    } catch (error) {
        console.error('Erreur POST /api/calls:', error);
        res.status(500).json({ error: 'Erreur lors de l\'enregistrement de l\'appel' });
    }
});

/**
 * PUT /api/calls/:id/answer
 * Marquer un appel comme répondu par l'utilisateur courant
 */
router.put('/:id/answer', verifyToken, (req, res) => {
    try {
        const call = db.getCallById(req.params.id);
        if (!call) {
            return res.status(404).json({ error: 'Appel non trouvé' });
        }

        const now = Math.floor(Date.now() / 1000);
        const updated = db.updateCall(req.params.id, {
            status: 'answered',
            answerTime: now,
            answeredByUserId: req.user.id,
            answeredByUsername: req.user.username,
            answeredByExtension: req.body.extension || null
        });

        // Broadcaster la mise à jour
        if (pushService && pushService.broadcast) {
            pushService.broadcast('CALL_ANSWERED', {
                callId: req.params.id,
                answeredBy: req.user.username,
                answeredByUserId: req.user.id,
                answerTime: now
            });
        }

        res.json(updated);
    } catch (error) {
        console.error('Erreur PUT /api/calls/:id/answer:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

/**
 * PUT /api/calls/:id/end
 * Terminer un appel (mettre à jour la durée et end_time)
 */
router.put('/:id/end', verifyToken, (req, res) => {
    try {
        const call = db.getCallById(req.params.id);
        if (!call) {
            return res.status(404).json({ error: 'Appel non trouvé' });
        }

        const now = Math.floor(Date.now() / 1000);
        const duration = call.answerTime ? now - call.answerTime : 0;

        // Si l'appel n'a jamais été répondu, le marquer comme manqué
        const status = call.answerTime ? 'answered' : 'missed';

        const updated = db.updateCall(req.params.id, {
            status,
            endTime: now,
            duration
        });

        // Broadcaster la fin de l'appel
        if (pushService && pushService.broadcast) {
            pushService.broadcast('CALL_ENDED', {
                callId: req.params.id,
                status,
                duration,
                endTime: now
            });

            // Si appel manqué, broadcaster spécifiquement
            if (status === 'missed') {
                pushService.broadcast('MISSED_CALL', updated);
            }
        }

        res.json(updated);
    } catch (error) {
        console.error('Erreur PUT /api/calls/:id/end:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

/**
 * PUT /api/calls/:id/seen
 * Marquer un appel comme vu
 */
router.put('/:id/seen', verifyToken, (req, res) => {
    try {
        const updated = db.updateCall(req.params.id, { seen: true });
        if (!updated) {
            return res.status(404).json({ error: 'Appel non trouvé' });
        }
        res.json(updated);
    } catch (error) {
        console.error('Erreur PUT /api/calls/:id/seen:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

/**
 * PUT /api/calls/mark-all-seen
 * Marquer tous les appels manqués comme vus
 */
router.put('/mark-all-seen', verifyToken, (req, res) => {
    try {
        db.markAllMissedCallsAsSeen();
        res.json({ success: true });
    } catch (error) {
        console.error('Erreur PUT /api/calls/mark-all-seen:', error);
        res.status(500).json({ error: 'Erreur lors de la mise à jour' });
    }
});

/**
 * DELETE /api/calls/purge
 * Purger les anciens appels (ADMIN ONLY)
 */
router.delete('/purge', verifyToken, isAdmin, [
    query('days').optional().isInt({ min: 1, max: 365 })
], (req, res) => {
    try {
        const { days = 90 } = req.query;
        const deleted = db.purgeOldCalls(parseInt(days));
        res.json({ deleted, message: `${deleted} appel(s) de plus de ${days} jours supprimé(s)` });
    } catch (error) {
        console.error('Erreur DELETE /api/calls/purge:', error);
        res.status(500).json({ error: 'Erreur lors de la purge' });
    }
});

module.exports = router;
