const express = require('express');
const passport = require('passport');

const router = express.Router();


router.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

router.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/' }),
    (req, res) => {
        if (req.user) {
            return res.redirect('/');
        }
        res.status(403).send('Access denied: You are not authorized to access this site.');
    }
);

router.get('/logout', (req, res) => {
    req.logout(err => {
        if (err) {
            console.error('Logout error:', err);
            return res.status(500).send('Logout failed');
        }
        res.redirect('/');
    });
});

router.get('/api/check-auth', (req, res) => {
    if (req.isAuthenticated()) {
        return res.status(200).json({ authenticated: true });
    }
    res.status(401).json({ authenticated: false });
});

module.exports = router;