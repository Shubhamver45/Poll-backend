const rateLimit = require('express-rate-limit');

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100,
    message: {
        error: 'Too many requests from this IP, please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Strict rate limiter for voting
const voteLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // max 10 vote attempts per minute per IP
    message: {
        error: 'Too many voting attempts. Please slow down.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate limiter for poll creation
const createPollLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // max 20 polls per hour per IP
    message: {
        error: 'Too many polls created. Please try again later.',
    },
    standardHeaders: true,
    legacyHeaders: false,
});

module.exports = { apiLimiter, voteLimiter, createPollLimiter };
