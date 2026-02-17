const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const pollService = require('../services/pollService');
const { voteLimiter, createPollLimiter } = require('../middleware/rateLimiter');

// Helper: get client IP (works behind Render's reverse proxy)
const getClientIp = (req) => {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        req.ip
    );
};

// POST /api/polls — Create a new poll
router.post('/', createPollLimiter, async (req, res) => {
    try {
        const { question, options } = req.body;

        // Validation
        if (!question || typeof question !== 'string' || !question.trim()) {
            return res.status(400).json({ error: 'Question is required.' });
        }

        if (!options || !Array.isArray(options) || options.length < 2) {
            return res.status(400).json({ error: 'At least 2 options are required.' });
        }

        if (options.length > 10) {
            return res.status(400).json({ error: 'Maximum 10 options allowed.' });
        }

        // Sanitize options
        const sanitized = options.map((o) => (typeof o === 'string' ? o.trim() : ''));
        const trimmedOptions = sanitized.filter((o) => o.length > 0);

        if (trimmedOptions.length < 2) {
            return res.status(400).json({ error: 'At least 2 non-empty options are required.' });
        }

        for (const opt of trimmedOptions) {
            if (opt.length > 200) {
                return res.status(400).json({ error: 'Each option must be 200 characters or less.' });
            }
        }

        // Check for duplicates
        const uniqueOptions = [...new Set(trimmedOptions.map((o) => o.toLowerCase()))];
        if (uniqueOptions.length !== trimmedOptions.length) {
            return res.status(400).json({ error: 'Duplicate options are not allowed.' });
        }

        // Generate unique share ID (retry on collision)
        let shareId;
        let exists = true;
        let attempts = 0;
        while (exists && attempts < 5) {
            shareId = uuidv4().slice(0, 8);
            exists = await pollService.shareIdExists(shareId);
            attempts++;
        }
        if (exists) {
            return res.status(500).json({ error: 'Failed to generate unique poll ID. Try again.' });
        }

        const poll = await pollService.createPoll(
            question.trim().slice(0, 500),
            trimmedOptions,
            shareId,
            getClientIp(req)
        );

        res.status(201).json({
            success: true,
            poll: {
                id: poll.id,
                question: poll.question,
                options: poll.options,
                shareId: poll.shareId,
                totalVotes: poll.totalVotes,
                createdAt: poll.createdAt,
            },
        });
    } catch (err) {
        console.error('Create poll error:', err);
        res.status(500).json({ error: 'Failed to create poll.' });
    }
});

// GET /api/polls/:shareId — Get poll by share ID
router.get('/:shareId', async (req, res) => {
    try {
        const { shareId } = req.params;

        if (!shareId || shareId.length > 20) {
            return res.status(400).json({ error: 'Invalid poll ID.' });
        }

        const poll = await pollService.getPollByShareId(shareId);

        if (!poll) {
            return res.status(404).json({ error: 'Poll not found.' });
        }

        // Check if voter already voted
        const voterId = req.cookies?.voterId || req.query.voterId;
        const clientIp = getClientIp(req);

        let hasVoted = false;
        let votedOptionIndex = -1;

        // Check by voterId
        if (voterId) {
            const voterVote = poll.voteRecords.find((v) => v.voterId === voterId);
            if (voterVote) {
                hasVoted = true;
                votedOptionIndex = voterVote.optionIndex;
            }
        }

        // Check by IP
        if (!hasVoted) {
            const ipVote = poll.voteRecords.find((v) => v.ip === clientIp);
            if (ipVote) {
                hasVoted = true;
                votedOptionIndex = ipVote.optionIndex;
            }
        }

        res.json({
            success: true,
            poll: {
                id: poll.id,
                question: poll.question,
                options: poll.options,
                shareId: poll.shareId,
                totalVotes: poll.totalVotes,
                isActive: poll.isActive,
                createdAt: poll.createdAt,
            },
            hasVoted,
            votedOptionIndex,
        });
    } catch (err) {
        console.error('Get poll error:', err);
        res.status(500).json({ error: 'Failed to fetch poll.' });
    }
});

// POST /api/polls/:shareId/vote — Vote on a poll
router.post('/:shareId/vote', voteLimiter, async (req, res) => {
    try {
        const { optionIndex, voterId } = req.body;
        const clientIp = getClientIp(req);

        if (optionIndex === undefined || optionIndex === null || typeof optionIndex !== 'number') {
            return res.status(400).json({ error: 'Valid option index is required.' });
        }

        if (!Number.isInteger(optionIndex) || optionIndex < 0) {
            return res.status(400).json({ error: 'Invalid option index.' });
        }

        // Get the poll first to validate
        const poll = await pollService.getPollByShareId(req.params.shareId);

        if (!poll) {
            return res.status(404).json({ error: 'Poll not found.' });
        }

        if (!poll.isActive) {
            return res.status(400).json({ error: 'This poll is no longer active.' });
        }

        if (optionIndex >= poll.options.length) {
            return res.status(400).json({ error: 'Invalid option index.' });
        }

        // Use the effective voterId
        const effectiveVoterId = (voterId && typeof voterId === 'string')
            ? voterId
            : `anon-${uuidv4().slice(0, 8)}`;

        // Record the vote (atomic — checks + insert in one transaction)
        const result = await pollService.recordVote(poll.id, optionIndex, effectiveVoterId, clientIp);

        // Handle anti-abuse errors from the atomic function
        if (result.error === 'already_voted_voter') {
            return res.status(409).json({
                error: 'You have already voted on this poll.',
                votedOptionIndex: result.votedOptionIndex,
            });
        }
        if (result.error === 'already_voted_ip') {
            return res.status(409).json({
                error: 'A vote has already been recorded from your network.',
                votedOptionIndex: result.votedOptionIndex,
            });
        }

        // Set voterId cookie
        if (voterId) {
            res.cookie('voterId', voterId, {
                httpOnly: true,
                maxAge: 365 * 24 * 60 * 60 * 1000,
                sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
                secure: process.env.NODE_ENV === 'production',
            });
        }

        // Broadcast via Socket.IO
        const io = req.app.get('io');
        if (io) {
            io.to(req.params.shareId).emit('poll-updated', {
                options: result.options,
                totalVotes: result.totalVotes,
            });
        }

        res.json({
            success: true,
            poll: {
                id: poll.id,
                question: poll.question,
                options: result.options,
                shareId: poll.shareId,
                totalVotes: result.totalVotes,
            },
            votedOptionIndex: optionIndex,
        });
    } catch (err) {
        console.error('Vote error:', err);
        res.status(500).json({ error: 'Failed to record vote.' });
    }
});

module.exports = router;
