
const express = require("express");
const mongoose = require("mongoose");

const router = express.Router();

/* =========================
   MONGODB SCHEMAS
========================= */

const matchupSchema = new mongoose.Schema({
    pair: [String],
    votes: {
        type: Map,
        of: Number,
        default: {}
    },
    voters: {
        type: [String],
        default: []
    }
});

const roundSchema = new mongoose.Schema({
    name: String,
    roundStart: Date,
    roundEnd: Date,
    matchups: [matchupSchema]
});

const bracketSchema = new mongoose.Schema({
    topic: {
        type: String,
        required: true
    },

    contestants: [String],

    month: Number,
    year: Number,

    currentRound: {
        type: Number,
        default: 0
    },

    matchups: [matchupSchema],

    roundHistory: [roundSchema],

    roundDurationDays: {
        type: Number,
        default: 7
    },

    roundStart: Date,
    roundEnd: Date,

    votingEnabled: {
        type: Boolean,
        default: true
    },

    tournamentEnded: {
        type: Boolean,
        default: false
    },

    tournamentWinner: {
        type: String,
        default: null
    }

}, { timestamps: true });

const winnerSchema = new mongoose.Schema({
    topic: String,
    winner: String,
    completedAt: {
        type: Date,
        default: Date.now
    }
});

const Bracket =
    mongoose.models.Bracket ||
    mongoose.model("Bracket", bracketSchema);

const Winner =
    mongoose.models.Winner ||
    mongoose.model("Winner", winnerSchema);


/* =========================
   HELPER FUNCTIONS
========================= */

const getRoundEnd = (start, days) => {
    return new Date(
        start.getTime() + days * 24 * 60 * 60 * 1000
    );
};

const generateMatchups = (contestants) => {
    const matchups = [];

    for (let i = 0; i < contestants.length; i += 2) {
        const pair = [contestants[i]];

        if (contestants[i + 1]) {
            pair.push(contestants[i + 1]);
        }

        const votes = {};

        pair.forEach(name => {
            votes[name] = 0;
        });

        matchups.push({
            pair,
            votes,
            voters: []
        });
    }

    return matchups;
};

const getVotersIP = (req) => {
    return (
        req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
        req.socket.remoteAddress
    );
};


/* =========================
   CREATE BRACKET
========================= */

const createBracket = async (settings) => {

    const {
        topic,
        contestants,
        month,
        year,
        roundDurationDays = 7,
        votingEnabled = true
    } = settings;

    if (
        typeof topic !== "string" ||
        !topic.trim() ||
        !Array.isArray(contestants)
    ) {
        throw new Error("Invalid bracket information");
    }

    if (
        !Number.isInteger(roundDurationDays) ||
        roundDurationDays < 1
    ) {
        throw new Error("Round duration must be at least one day");
    }

    if (typeof votingEnabled !== "boolean") {
        throw new Error("Invalid voting setting");
    }

    const cleanContestants = [
        ...new Set(
            contestants
                .filter(name => typeof name === "string")
                .map(name => name.trim())
                .filter(Boolean)
        )
    ];

    if (cleanContestants.length < 2) {
        throw new Error("At least two unique contestants are required");
    }

    if (
        (month !== undefined &&
            (!Number.isInteger(month) || month < 1 || month > 12)) ||
        (year !== undefined &&
            (!Number.isInteger(year) || year < 2000))
    ) {
        throw new Error("Invalid tournament month or year");
    }

    const now = new Date();

    const bracket = new Bracket({
        topic: topic.trim(),
        contestants: cleanContestants,

        month,
        year,

        currentRound: 0,

        matchups: generateMatchups(cleanContestants),

        roundHistory: [],

        roundDurationDays,

        roundStart: now,
        roundEnd: getRoundEnd(now, roundDurationDays),

        votingEnabled,
        tournamentEnded: false
    });

    await bracket.save();

    return bracket;
};


/* =========================
   ADVANCE ROUND
========================= */

const advanceRound = async (bracket) => {

    if (!bracket || bracket.tournamentEnded) {
        throw new Error("Tournament has already ended");
    }

    if (!bracket.matchups.length) {
        throw new Error("No matchups available");
    }

    const winners = bracket.matchups.map(match => {

        const [a, b] = match.pair;

        // Automatic bye
        if (!b) return a;

        const aVotes = match.votes.get(a) || 0;
        const bVotes = match.votes.get(b) || 0;

        return aVotes >= bVotes ? a : b;
    });

    // Save the completed round
    bracket.roundHistory.push({
        name: `Round ${bracket.currentRound + 1}`,
        roundStart: bracket.roundStart,
        roundEnd: bracket.roundEnd,
        matchups: bracket.matchups
    });

    // Tournament finished
    if (winners.length === 1) {

        const tournamentWinner = winners[0];

        await Winner.create({
            topic: bracket.topic,
            winner: tournamentWinner
        });

        bracket.tournamentEnded = true;
        bracket.tournamentWinner = tournamentWinner;

        await bracket.save();

        return bracket;
    }

    // Generate next round
    const now = new Date();

    bracket.matchups = generateMatchups(winners);

    bracket.currentRound += 1;

    bracket.roundStart = now;

    bracket.roundEnd = getRoundEnd(
        now,
        bracket.roundDurationDays
    );

    await bracket.save();

    return bracket;
};


/* =========================
   AUTOMATIC ADVANCEMENT
========================= */

const advanceRoundIfNeeded = async (bracket) => {

    if (!bracket || bracket.tournamentEnded) {
        return bracket;
    }

    if (
        bracket.roundEnd &&
        new Date() >= bracket.roundEnd
    ) {
        return await advanceRound(bracket);
    }

    return bracket;
};


/* =========================
   GET CURRENT BRACKET
========================= */

router.get("/", async (req, res) => {
    try {

        let bracket = await Bracket.findOne();

        if (!bracket) {
            return res.json(null);
        }

        bracket = await advanceRoundIfNeeded(bracket);

        res.json(bracket);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* =========================
   CREATE NEW BRACKET
========================= */

router.post("/", async (req, res) => {
    try {

        const existing = await Bracket.findOne();

        if (existing && !existing.tournamentEnded) {
            return res.status(400).json({
                error: "An active bracket already exists"
            });
        }

        if (existing) {
            await Bracket.deleteMany({});
        }

        const bracket = await createBracket(req.body);

        res.status(201).json(bracket);

    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


/* =========================
   UPDATE SETTINGS
========================= */

router.put("/", async (req, res) => {
    try {

        const bracket = await Bracket.findOne();

        if (!bracket) {
            return res.status(404).json({
                error: "No bracket found"
            });
        }

        if (bracket.tournamentEnded) {
            return res.status(400).json({
                error: "Tournament has ended"
            });
        }

        const {
            topic,
            votingEnabled,
            roundDurationDays
        } = req.body;

        if (topic !== undefined) {
            if (typeof topic !== "string" || !topic.trim()) {
                return res.status(400).json({
                    error: "Invalid topic"
                });
            }

            bracket.topic = topic.trim();
        }

        if (votingEnabled !== undefined) {
            if (typeof votingEnabled !== "boolean") {
                return res.status(400).json({
                    error: "Invalid voting setting"
                });
            }

            bracket.votingEnabled = votingEnabled;
        }

        if (roundDurationDays !== undefined) {

            if (
                !Number.isInteger(roundDurationDays) ||
                roundDurationDays < 1
            ) {
                return res.status(400).json({
                    error: "Invalid round duration"
                });
            }

            bracket.roundDurationDays = roundDurationDays;

            bracket.roundEnd = getRoundEnd(
                bracket.roundStart,
                roundDurationDays
            );
        }

        await bracket.save();

        res.json(bracket);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* =========================
   VOTE
========================= */

router.put("/vote", async (req, res) => {
    try {

        let bracket = await Bracket.findOne();

        if (!bracket) {
            return res.status(404).json({
                error: "No bracket found"
            });
        }

        bracket = await advanceRoundIfNeeded(bracket);

        if (bracket.tournamentEnded) {
            return res.status(400).json({
                error: "Tournament has ended"
            });
        }

        if (!bracket.votingEnabled) {
            return res.status(403).json({
                error: "Voting is disabled"
            });
        }

        const { matchupIndex, choice } = req.body;

        const matchup = bracket.matchups[matchupIndex];

        if (!matchup || !matchup.pair.includes(choice)) {
            return res.status(400).json({
                error: "Invalid vote"
            });
        }

        const userIP = getVotersIP(req);

        if (matchup.voters.includes(userIP)) {
            return res.status(403).json({
                error: "You already voted"
            });
        }

        const currentVotes = matchup.votes.get(choice) || 0;

        matchup.votes.set(choice, currentVotes + 1);

        matchup.voters.push(userIP);

        await bracket.save();

        res.json(bracket);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* =========================
   MANUAL ADVANCE
========================= */

router.post("/advance", async (req, res) => {
    try {

        const bracket = await Bracket.findOne();

        if (!bracket) {
            return res.status(404).json({
                error: "No bracket found"
            });
        }

        const updated = await advanceRound(bracket);

        res.json(updated);

    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});


/* =========================
   GET PAST WINNERS
========================= */

router.get("/winners", async (req, res) => {
    try {

        const winners = await Winner.find().sort({
            completedAt: -1
        });

        res.json(winners);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


/* =========================
   RESET BRACKET
========================= */

router.delete("/reset", async (req, res) => {
    try {

        await Bracket.deleteMany({});

        res.json({
            message: "Bracket reset"
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


module.exports = router;
