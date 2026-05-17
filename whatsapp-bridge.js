/**
 * MechTrack — WhatsApp Bridge for Render
 * Runs 24/7 on Render, pushes QR to Railway, auto-reconnects on disconnect
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ✅ CORS — allow requests from any origin (Railway, browser, etc.)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// Render assigns PORT via env variable
const PORT = process.env.PORT || 4322;
const SESSION_PATH = path.join(__dirname, 'whatsapp-session');

// Your Railway backend — QR gets pushed here
const RAILWAY_URL = process.env.RAILWAY_URL || "https://mech-production-30d8.up.railway.app";

// Ensure public directory exists
if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

let client = null;
let currentQrBase64 = null;
let isReady = false;
let isInitializing = false;
let reconnectTimer = null;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon}  ${msg}`);
}

// ─── Push QR to Railway ────────────────────────────────────────────────────

async function pushQrToRailway(qrBase64) {
    try {
        log('☁️', 'Pushing QR to Railway...');
        const response = await fetch(`${RAILWAY_URL}/whatsapp/push-qr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr: qrBase64 })
        });
        if (response.ok) {
            log('✅', `QR pushed! Scan at: ${RAILWAY_URL}/whatsapp/qr`);
        } else {
            log('⚠️', `Railway returned: ${response.status}`);
        }
    } catch (err) {
        log('⚠️', `Failed to push QR: ${err.message}`);
    }
}

// ─── WhatsApp Client ───────────────────────────────────────────────────────

async function destroyClient() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (client) {
        try {
            client.removeAllListeners();
            await client.destroy();
        } catch (e) {}
        client = null;
    }
    isReady = false;
    isInitializing = false;
}

async function initializeClient() {
    if (isInitializing) {
        log('⏳', 'Already initializing...');
        return;
    }

    isInitializing = true;
    currentQrBase64 = null;

    if (fs.existsSync(SESSION_PATH)) {
        log('💾', 'Found saved session — reconnecting without QR scan...');
    } else {
        log('🆕', 'No session found — will generate QR...');
    }

    log('🚀', 'Starting WhatsApp client...');

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_PATH,
            clientId: 'mechtrack'
        }),
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
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--hide-scrollbars',
                '--mute-audio',
                '--disable-background-timer-throttling',
                '--window-size=800,600'
            ],
            ignoreHTTPSErrors: true,
            defaultViewport: null,
        },
    });

    // QR received — generate base64 and push to Railway
    client.on('qr', async (qr) => {
        log('📱', 'New QR received!');
        try {
            currentQrBase64 = await qrcode.toDataURL(qr, { margin: 2, width: 300 });
            await pushQrToRailway(currentQrBase64);
        } catch (err) {
            log('❌', `QR error: ${err.message}`);
        }
    });

    client.on('authenticated', () => {
        log('✅', 'Authenticated successfully');
    });

    // ✅ Stay alive — no process.exit
    client.on('ready', () => {
        log('🎉', 'WhatsApp READY! Running 24/7 on Render.');
        isReady = true;
        isInitializing = false;
        currentQrBase64 = null;
    });

    client.on('auth_failure', async (msg) => {
        log('❌', `Auth failed: ${msg}`);
        log('🗑️', 'Clearing bad session and retrying in 10s...');
        isInitializing = false;
        // Clear corrupt session
        try {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        } catch (e) {}
        reconnectTimer = setTimeout(() => initializeClient(), 10000);
    });

    // ✅ Auto-reconnect on disconnect
    client.on('disconnected', async (reason) => {
        log('⚠️', `Disconnected: ${reason}`);
        isReady = false;
        isInitializing = false;
        log('🔄', 'Reconnecting in 5 seconds...');
        await destroyClient();
        reconnectTimer = setTimeout(() => initializeClient(), 5000);
    });

    try {
        await client.initialize();
    } catch (err) {
        log('❌', `Init error: ${err.message}`);
        isInitializing = false;
        log('🔄', 'Retrying in 15 seconds...');
        reconnectTimer = setTimeout(() => initializeClient(), 15000);
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        service: 'MechTrack WhatsApp Bridge',
        status: isReady ? '✅ Connected' : isInitializing ? '⏳ Connecting...' : '❌ Disconnected',
        ready: isReady,
        railway_url: RAILWAY_URL
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', ready: isReady, connecting: isInitializing });
});

app.get('/status', (req, res) => {
    res.json({ ready: isReady, connecting: isInitializing });
});

app.get('/qr', async (req, res) => {
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
        return res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

app.post('/disconnect', async (req, res) => {
    try {
        await destroyClient();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    try {
        // Clear session so fresh QR is generated
        await destroyClient();
        try {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        } catch (e) {}
        setTimeout(() => initializeClient(), 2000);
        res.json({ success: true, message: 'Resetting — new QR will be generated' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── Start ────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `Bridge running on port ${PORT}`);
    log('☁️', `Railway URL: ${RAILWAY_URL}`);
    initializeClient();
});

process.on('SIGTERM', async () => {
    log('🛑', 'SIGTERM received, shutting down gracefully...');
    await destroyClient();
    process.exit(0);
});
