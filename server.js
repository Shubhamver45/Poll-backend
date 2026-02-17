require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { testConnection } = require('./config/db');
const pollRoutes = require('./routes/pollRoutes');
const { apiLimiter } = require('./middleware/rateLimiter');
const setupPollSocket = require('./sockets/pollSocket');

const app = express();
const server = http.createServer(app);

// Trust proxy for Render / reverse proxies (required for rate limiting + IP detection)
app.set('trust proxy', 1);

// CORS configuration
const allowedOrigins = [
    process.env.CLIENT_URL || 'http://localhost:5173',
    'http://localhost:5173',
    'http://localhost:3000',
];

const corsOptions = {
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, Render health checks)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        // In production, allow any vercel.app domain
        if (origin.endsWith('.vercel.app')) {
            return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// Apply general rate limiter to all /api routes
app.use('/api', apiLimiter);

// Socket.io setup
const io = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.includes(origin) || origin.endsWith('.vercel.app')) {
                return callback(null, true);
            }
            return callback(new Error('Not allowed by CORS'));
        },
        methods: ['GET', 'POST'],
        credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

// Health check endpoint
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        message: '🗳️ PollRoom API is running',
        version: '1.0.0',
        uptime: Math.floor(process.uptime()),
        endpoints: {
            createPoll: 'POST /api/polls',
            getPoll: 'GET /api/polls/:shareId',
            vote: 'POST /api/polls/:shareId/vote',
        },
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok' });
});

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api/polls', pollRoutes);

// Setup WebSocket handlers
setupPollSocket(io);

// Start server after testing Supabase connection
const PORT = process.env.PORT || 5000;

testConnection().then(() => {
    server.listen(PORT, () => {
        console.log(`🚀 Server running on port ${PORT}`);
        console.log(`📡 WebSocket server ready`);
        console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
    });
});

module.exports = { app, server };
