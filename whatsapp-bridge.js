/**
 * MechTrack — WhatsApp Bridge
 * Runs on Render, pushes QR + connected state to Railway app.py
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4322;
const SESSION_PATH = path.join(__dirname, 'whatsapp-session');
const RAILWAY_URL = (process.env.RAILWAY_URL || "https://mech-production-30d8.up.railway.app").replace(/\/$/, '');

let client = null;
let currentQrBase64 = null;
let isReady = false;
let isInitializing = false;
let reconnectTimer = null;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon}  ${msg}`);
}

// ── Push helpers ─────────────────────────────────────────────────────────────

async function pushToRailway(endpoint, body) {
    try {
        const res = await fetch(`${RAILWAY_URL}${endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return res.ok;
    } catch (err) {
        log('⚠️', `Push to ${endpoint} failed: ${err.message}`);
        return false;
    }
}

async function pushQR(qrBase64) {
    log('☁️', 'Pushing QR to Railway...');
    const ok = await pushToRailway('/whatsapp/push-qr', { qr: qrBase64 });
    log(ok ? '✅' : '⚠️', ok ? 'QR pushed to Railway' : 'QR push failed');
}

async function pushConnected(phone) {
    log('☁️', `Pushing connected state to Railway — phone: ${phone}`);
    const ok = await pushToRailway('/whatsapp/push-connected', { phone });
    log(ok ? '✅' : '⚠️', ok ? 'Railway notified: WhatsApp connected' : 'Railway notify failed');
}

async function pushDisconnected() {
    log('☁️', 'Pushing disconnected state to Railway...');
    await pushToRailway('/whatsapp/push-disconnected', {});
}

// ── WhatsApp Client ──────────────────────────────────────────────────────────

async function destroyClient() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (client) {
        try { client.removeAllListeners(); await client.destroy(); } catch (e) {}
        client = null;
    }
    isReady = false;
    isInitializing = false;
}

async function initializeClient() {
    if (isInitializing) { log('⏳', 'Already initializing...'); return; }

    isInitializing = true;
    currentQrBase64 = null;

    log('🚀', fs.existsSync(SESSION_PATH)
        ? 'Saved session found — reconnecting without QR...'
        : 'No session — will generate QR for first-time scan...'
    );

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: SESSION_PATH, clientId: 'mechtrack' }),
        webVersion: '2.2412.54',
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            timeout: 120000,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas', '--disable-gpu', '--no-first-run',
                '--no-zygote', '--single-process', '--disable-extensions',
                '--disable-background-networking', '--disable-default-apps',
                '--disable-sync', '--disable-translate', '--hide-scrollbars',
                '--mute-audio', '--disable-background-timer-throttling',
                '--window-size=800,600'
            ],
            ignoreHTTPSErrors: true,
            defaultViewport: null,
        },
    });

    // QR generated — push to Railway so frontend can display it
    client.on('qr', async (qr) => {
        log('📱', 'QR received — generating base64...');
        try {
            currentQrBase64 = await qrcode.toDataURL(qr, { margin: 2, width: 300 });
            await pushQR(currentQrBase64);
        } catch (err) {
            log('❌', `QR generation error: ${err.message}`);
        }
    });

    client.on('authenticated', () => {
        log('✅', 'Authenticated — session saved');
    });

    // ✅ KEY FIX: push connected state to Railway so messages can be sent
    client.on('ready', async () => {
        log('🎉', 'WhatsApp is READY!');
        isReady = true;
        isInitializing = false;
        currentQrBase64 = null;

        try {
            const phone = client.info?.wid?.user || 'unknown';
            log('📞', `Logged in as: +${phone}`);
            await pushConnected(phone);
        } catch (e) {
            log('⚠️', `Could not read phone info: ${e.message}`);
            await pushConnected('unknown');
        }
    });

    client.on('auth_failure', async (msg) => {
        log('❌', `Auth failed: ${msg} — clearing session and retrying in 10s...`);
        isInitializing = false;
        try {
            if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        } catch (e) {}
        reconnectTimer = setTimeout(initializeClient, 10000);
    });

    // Auto-reconnect on disconnect
    client.on('disconnected', async (reason) => {
        log('⚠️', `Disconnected: ${reason} — reconnecting in 5s...`);
        isReady = false;
        await pushDisconnected();
        await destroyClient();
        reconnectTimer = setTimeout(initializeClient, 5000);
    });

    try {
        await client.initialize();
    } catch (err) {
        log('❌', `Init error: ${err.message} — retrying in 15s...`);
        isInitializing = false;
        reconnectTimer = setTimeout(initializeClient, 15000);
    }
}

// ── Routes ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
    service: 'MechTrack WhatsApp Bridge',
    status: isReady ? '✅ Connected' : isInitializing ? '⏳ Connecting...' : '❌ Disconnected',
    ready: isReady,
    railway_url: RAILWAY_URL
}));

app.get('/health', (req, res) => res.json({ status: 'ok', ready: isReady, connecting: isInitializing }));

app.get('/status', (req, res) => res.json({ ready: isReady, connecting: isInitializing }));

app.get('/qr', (req, res) => {
    if (isReady) return res.json({ qr: null, ready: true });
    if (currentQrBase64) return res.json({ qr: currentQrBase64, ready: false });
    res.json({ qr: null, ready: false, connecting: isInitializing });
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    if (!isReady || !client) return res.status(503).json({ error: 'WhatsApp not ready' });

    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (!clean.startsWith('91')) clean = '91' + clean;

    try {
        const chatId = `${clean}@c.us`;
        const numberDetails = await client.getNumberId(chatId);
        if (!numberDetails) return res.status(400).json({ error: 'Number not on WhatsApp' });
        const sent = await client.sendMessage(chatId, message);
        log('📤', `Message sent to ${clean}`);
        return res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        log('❌', `Send failed: ${err.message}`);
        return res.status(500).json({ error: err.message });
    }
});

app.post('/disconnect', async (req, res) => {
    try {
        await pushDisconnected();
        await destroyClient();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    try {
        await destroyClient();
        try {
            if (fs.existsSync(SESSION_PATH)) fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        } catch (e) {}
        setTimeout(initializeClient, 2000);
        res.json({ success: true, message: 'Resetting — new QR will be generated in ~2s' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `Bridge running on port ${PORT}`);
    log('☁️', `Railway backend: ${RAILWAY_URL}`);
    initializeClient();
});

process.on('SIGTERM', async () => {
    log('🛑', 'Shutting down gracefully...');
    await pushDisconnected();
    await destroyClient();
    process.exit(0);
});
