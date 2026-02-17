const pollService = require('../services/pollService');

module.exports = (io) => {
    // Track active viewers per poll room
    const roomViewers = new Map();

    io.on('connection', (socket) => {
        console.log(`🔌 Client connected: ${socket.id}`);

        // Join a poll room
        socket.on('join-poll', async (shareId) => {
            if (!shareId || typeof shareId !== 'string') return;

            socket.join(shareId);

            // Track viewer count
            const current = roomViewers.get(shareId) || 0;
            roomViewers.set(shareId, current + 1);

            console.log(`📊 Socket ${socket.id} joined poll: ${shareId} (${current + 1} viewers)`);

            // Send current poll data to the joining client
            try {
                const poll = await pollService.getPollByShareId(shareId);
                if (poll) {
                    socket.emit('poll-data', {
                        options: poll.options,
                        totalVotes: poll.totalVotes,
                    });
                }
            } catch (err) {
                console.error('Error fetching poll for socket:', err);
            }

            // Broadcast viewer count to all in room
            io.to(shareId).emit('viewer-count', {
                count: roomViewers.get(shareId) || 0,
            });
        });

        // Leave a poll room
        socket.on('leave-poll', (shareId) => {
            if (!shareId || typeof shareId !== 'string') return;

            socket.leave(shareId);

            const current = roomViewers.get(shareId) || 0;
            roomViewers.set(shareId, Math.max(0, current - 1));

            console.log(`🚪 Socket ${socket.id} left poll: ${shareId}`);

            io.to(shareId).emit('viewer-count', {
                count: roomViewers.get(shareId) || 0,
            });
        });

        // Handle vote via socket
        socket.on('vote', async ({ shareId, optionIndex, voterId }) => {
            try {
                // Input validation
                if (!shareId || typeof shareId !== 'string') {
                    socket.emit('vote-error', { error: 'Invalid poll ID.' });
                    return;
                }

                if (typeof optionIndex !== 'number' || !Number.isInteger(optionIndex) || optionIndex < 0) {
                    socket.emit('vote-error', { error: 'Invalid option.' });
                    return;
                }

                // Get poll to validate
                const poll = await pollService.getPollByShareId(shareId);

                if (!poll) {
                    socket.emit('vote-error', { error: 'Poll not found.' });
                    return;
                }

                if (!poll.isActive) {
                    socket.emit('vote-error', { error: 'This poll is no longer active.' });
                    return;
                }

                if (optionIndex >= poll.options.length) {
                    socket.emit('vote-error', { error: 'Invalid option.' });
                    return;
                }

                // Get IP from socket handshake
                const clientIp =
                    socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
                    socket.handshake.address;

                const effectiveVoterId = (voterId && typeof voterId === 'string')
                    ? voterId
                    : `anon-${Date.now()}`;

                // Record vote atomically
                const result = await pollService.recordVote(poll.id, optionIndex, effectiveVoterId, clientIp);

                // Handle anti-abuse errors
                if (result.error === 'already_voted_voter') {
                    socket.emit('vote-error', {
                        error: 'You have already voted.',
                        votedOptionIndex: result.votedOptionIndex,
                    });
                    return;
                }
                if (result.error === 'already_voted_ip') {
                    socket.emit('vote-error', {
                        error: 'A vote from your network already exists.',
                        votedOptionIndex: result.votedOptionIndex,
                    });
                    return;
                }

                // Broadcast updated results to ALL clients in the room
                io.to(shareId).emit('poll-updated', {
                    options: result.options,
                    totalVotes: result.totalVotes,
                });

                // Confirm vote to the voting client
                socket.emit('vote-success', {
                    votedOptionIndex: optionIndex,
                });
            } catch (err) {
                console.error('Socket vote error:', err);
                socket.emit('vote-error', { error: 'Failed to record vote.' });
            }
        });

        // Handle disconnect — clean up viewer counts
        socket.on('disconnect', () => {
            console.log(`❌ Client disconnected: ${socket.id}`);

            for (const room of socket.rooms) {
                if (room !== socket.id) {
                    const current = roomViewers.get(room) || 0;
                    roomViewers.set(room, Math.max(0, current - 1));
                    io.to(room).emit('viewer-count', {
                        count: roomViewers.get(room) || 0,
                    });
                }
            }
        });
    });
};
