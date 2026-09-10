const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const jwt = require('jsonwebtoken');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const { Server } = require('socket.io');
const { attachBrowser, stopListener } = require('./lib/formbar-listeners');

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me';
const RAW_AUTH_URL = process.env.AUTH_URL || 'https://formbar.yorktechapps.com';
const RAW_THIS_URL = process.env.THIS_URL || `http://localhost:${PORT}`;

function normalizeBase(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    return raw.replace(/\/+$/, '').replace(/\/oauth$/i, '');
}

function ensureLoginPath(urlBase) {
    return String(urlBase || '').replace(/\/+$/, '') + '/login';
}

const AUTH_URL = normalizeBase(RAW_AUTH_URL);
const FORMBAR_URL = AUTH_URL;
const THIS_URL = normalizeBase(RAW_THIS_URL) || `http://localhost:${PORT}`;
const LOGIN_REDIRECT_URL = ensureLoginPath(THIS_URL);

const dbDir = path.join(__dirname, 'db');
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const app = express();
const sessionMiddleware = session({
    store: new SQLiteStore({ db: 'sessions.db', dir: './db' }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { sameSite: 'lax' }
});

app.use(express.static(path.join(__dirname, 'public'), { index: false }));
app.use(express.json());
app.use(sessionMiddleware);

function isTeacherSession(sess) {
    const perms = sess && typeof sess.permissions === 'number' ? sess.permissions : null;
    return perms != null && perms >= 4;
}

function isAuthenticated(req, res, next) {
    if (!req.session.user) {
        return res.redirect('/login');
    }
    next();
}

app.get('/login', (req, res) => {
    const oauthUrl = `${AUTH_URL}/oauth?redirectURL=${encodeURIComponent(LOGIN_REDIRECT_URL)}`;

    if (!req.query.token) {
        return res.redirect(oauthUrl);
    }

    const rawJwt = String(req.query.token);
    const tokenData = jwt.decode(rawJwt);
    if (!tokenData) {
        return res.redirect(oauthUrl);
    }

    req.session.rawJwt = rawJwt;
    req.session.token = tokenData;
    req.session.user = tokenData.displayName || tokenData.username || 'Teacher';
    req.session.formbarId = tokenData.id != null ? tokenData.id : tokenData.sub;
    req.session.permissions = typeof tokenData.permissions === 'number' ? tokenData.permissions : null;
    req.session.activeClass = tokenData.activeClass != null ? tokenData.activeClass : null;

    req.session.save((err) => {
        if (err) console.error('Session save error:', err);
        res.redirect('/');
    });
});

app.get('/logout', (req, res) => {
    const formbarId = req.session.formbarId;
    req.session.destroy(() => {
        if (formbarId != null) stopListener(formbarId);
        res.redirect('/login');
    });
});

app.get('/', isAuthenticated, (req, res) => {
    if (!isTeacherSession(req.session)) {
        return res.sendFile(path.join(__dirname, 'public', 'denied.html'));
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = http.createServer(app);
const io = new Server(httpServer);

io.use((socket, next) => {
    sessionMiddleware(socket.request, {}, next);
});

io.on('connection', (socket) => {
    const sess = socket.request.session;
    if (!sess || !sess.user || !sess.rawJwt || sess.formbarId == null || !isTeacherSession(sess)) {
        socket.disconnect(true);
        return;
    }

    attachBrowser({
        formbarId: sess.formbarId,
        displayName: sess.user,
        rawJwt: sess.rawJwt,
        activeClass: sess.activeClass
    }, socket, FORMBAR_URL, process.env.API_KEY);
});

httpServer.listen(PORT, () => {
    console.log(`Consensus running at ${THIS_URL}`);
    console.log(`Formbar OAuth: ${AUTH_URL}/oauth?redirectURL=${encodeURIComponent(LOGIN_REDIRECT_URL)}`);
});
