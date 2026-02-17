const { supabase } = require('../config/db');

/**
 * Create a new poll with options.
 * @param {string} question
 * @param {string[]} options - Array of option text strings
 * @param {string} shareId
 * @param {string} createdBy - IP of the creator
 * @returns {object} Created poll with options
 */
async function createPoll(question, options, shareId, createdBy) {
    // 1. Insert the poll
    const { data: poll, error: pollError } = await supabase
        .from('polls')
        .insert({
            question,
            share_id: shareId,
            created_by: createdBy,
        })
        .select()
        .single();

    if (pollError) throw pollError;

    // 2. Insert all options
    const optionRows = options.map((text, index) => ({
        poll_id: poll.id,
        option_text: text,
        option_index: index,
        votes: 0,
    }));

    const { data: pollOptions, error: optionsError } = await supabase
        .from('poll_options')
        .insert(optionRows)
        .select()
        .order('option_index', { ascending: true });

    if (optionsError) throw optionsError;

    return {
        id: poll.id,
        question: poll.question,
        shareId: poll.share_id,
        totalVotes: poll.total_votes,
        isActive: poll.is_active,
        createdAt: poll.created_at,
        options: pollOptions.map((o) => ({
            id: o.id,
            text: o.option_text,
            votes: o.votes,
            _id: o.id, // compatibility with frontend
        })),
    };
}

/**
 * Check if a share ID already exists.
 */
async function shareIdExists(shareId) {
    const { data, error } = await supabase
        .from('polls')
        .select('id')
        .eq('share_id', shareId)
        .maybeSingle();

    if (error) throw error;
    return !!data;
}

/**
 * Get a poll by share ID with options and vote records.
 */
async function getPollByShareId(shareId) {
    // Get poll
    const { data: poll, error: pollError } = await supabase
        .from('polls')
        .select('*')
        .eq('share_id', shareId)
        .maybeSingle();

    if (pollError) throw pollError;
    if (!poll) return null;

    // Get options
    const { data: options, error: optionsError } = await supabase
        .from('poll_options')
        .select('*')
        .eq('poll_id', poll.id)
        .order('option_index', { ascending: true });

    if (optionsError) throw optionsError;

    // Get vote records
    const { data: voteRecords, error: votesError } = await supabase
        .from('vote_records')
        .select('*')
        .eq('poll_id', poll.id);

    if (votesError) throw votesError;

    return {
        id: poll.id,
        question: poll.question,
        shareId: poll.share_id,
        totalVotes: poll.total_votes,
        isActive: poll.is_active,
        createdAt: poll.created_at,
        options: options.map((o) => ({
            id: o.id,
            text: o.option_text,
            votes: o.votes,
            _id: o.id,
        })),
        voteRecords: voteRecords.map((v) => ({
            voterId: v.voter_id,
            ip: v.ip,
            optionIndex: v.option_index,
            votedAt: v.voted_at,
        })),
    };
}

/**
 * Check if a voter has already voted on a poll (by voterId).
 */
async function checkVoterVote(pollId, voterId) {
    const { data, error } = await supabase
        .from('vote_records')
        .select('option_index')
        .eq('poll_id', pollId)
        .eq('voter_id', voterId)
        .maybeSingle();

    if (error) throw error;
    return data ? { optionIndex: data.option_index } : null;
}

/**
 * Check if an IP has already voted on a poll.
 */
async function checkIpVote(pollId, ip) {
    const { data, error } = await supabase
        .from('vote_records')
        .select('option_index')
        .eq('poll_id', pollId)
        .eq('ip', ip)
        .maybeSingle();

    if (error) throw error;
    return data ? { optionIndex: data.option_index } : null;
}

/**
 * Record a vote atomically using the database function.
 * Returns updated poll data (options + totalVotes).
 */
async function recordVote(pollId, optionIndex, voterId, ip) {
    const { data, error } = await supabase.rpc('record_vote', {
        p_poll_id: pollId,
        p_option_index: optionIndex,
        p_voter_id: voterId,
        p_ip: ip,
    });

    if (error) {
        // Parse the custom error messages from our SQL function
        if (error.message.includes('VOTER_ALREADY_VOTED')) {
            const vote = await checkVoterVote(pollId, voterId);
            return { error: 'already_voted_voter', votedOptionIndex: vote?.optionIndex };
        }
        if (error.message.includes('IP_ALREADY_VOTED')) {
            const vote = await checkIpVote(pollId, ip);
            return { error: 'already_voted_ip', votedOptionIndex: vote?.optionIndex };
        }
        throw error;
    }

    // Transform the returned data to match frontend expected format
    return {
        success: true,
        totalVotes: data.totalVotes,
        options: data.options.map((o) => ({
            id: o.id,
            text: o.option_text,
            votes: o.votes,
            _id: o.id,
        })),
    };
}

/**
 * Get just poll options + totalVotes (for broadcasting updates).
 */
async function getPollResults(pollId) {
    const { data: poll, error: pollError } = await supabase
        .from('polls')
        .select('total_votes')
        .eq('id', pollId)
        .single();

    if (pollError) throw pollError;

    const { data: options, error: optionsError } = await supabase
        .from('poll_options')
        .select('id, option_text, option_index, votes')
        .eq('poll_id', pollId)
        .order('option_index', { ascending: true });

    if (optionsError) throw optionsError;

    return {
        totalVotes: poll.total_votes,
        options: options.map((o) => ({
            id: o.id,
            text: o.option_text,
            votes: o.votes,
            _id: o.id,
        })),
    };
}

module.exports = {
    createPoll,
    shareIdExists,
    getPollByShareId,
    checkVoterVote,
    checkIpVote,
    recordVote,
    getPollResults,
};
