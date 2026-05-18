const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// ✅ CORS — allow all origins
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const PORT = process.env.PORT || 4322;
const SESSION_PATH = path.join(__dirname, 'whatsapp-session');
const RAILWAY_API_URL = process.env.RAILWAY_API_URL || "https://mech-production-30d8.up.railway.app";

let client = null;
let currentQrBase64 = null;
let qrGeneratedAt = null;   // ✅ timestamp of latest QR
let isReady = false;
let isInitializing = false;
let reconnectTimer = null;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon} ${msg}`);
}

async function destroyClient() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (client) {
        try { client.removeAllListeners(); await client.destroy(); } catch (e) {}
        client = null;
    }
    isReady = false;
    isInitializing = false;
}

async function pushQrToRailway(qrBase64) {
    try {
        log('☁️', 'Pushing QR to Railway...');
        const response = await fetch(`${RAILWAY_API_URL}/whatsapp/push-qr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr: qrBase64, timestamp: new Date().toISOString() })
        });
        if (response.ok) {
            log('✅', `QR pushed! Scan at: ${RAILWAY_API_URL}/whatsapp/qr`);
        } else {
            log('⚠️', `Railway returned: ${response.status}`);
        }
    } catch (err) {
        log('⚠️', `Failed to push QR: ${err.message}`);
    }
}

async function initializeClient() {
    if (isInitializing) { log('⏳', 'Already initializing...'); return; }

    isInitializing = true;
    currentQrBase64 = null;

    if (fs.existsSync(SESSION_PATH)) {
        log('💾', 'Found saved session — reconnecting without QR...');
    } else {
        log('🆕', 'No session — will generate QR...');
    }

    log('🚀', 'Starting WhatsApp client...');

    client = new Client({
        authStrategy: new LocalAuth({
            dataPath: SESSION_PATH,
            clientId: 'mechtrack'
        }),
        // ✅ Latest working webVersion — DO NOT REMOVE
        webVersion: '2.3000.1015901307',
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1015901307.html'
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

    // ✅ QR received
    client.on('qr', async (qr) => {
        log('📱', 'QR CODE GENERATED!');
        try {
            currentQrBase64 = await qrcode.toDataURL(qr, {
                margin: 2, width: 300,
                color: { dark: '#000000', light: '#FFFFFF' }
            });
            qrGeneratedAt = new Date().toISOString();  // ✅ mark when this QR was made
            log('✅', `QR ready at ${qrGeneratedAt}`);
            await pushQrToRailway(currentQrBase64);
        } catch (err) {
            log('❌', `QR error: ${err.message}`);
        }
    });

    client.on('authenticated', () => {
        log('✅', 'Authenticated!');
    });

    // ✅ Stay alive — no process.exit
    client.on('ready', () => {
        log('🎉', 'WHATSAPP CONNECTED AND READY!');
        isReady = true;
        isInitializing = false;
        currentQrBase64 = null;

        // Notify Railway
        fetch(`${RAILWAY_API_URL}/whatsapp/bridge-ready`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ready' })
        }).catch(() => {});
    });

    client.on('auth_failure', async (msg) => {
        log('❌', `Auth failed: ${msg}`);
        log('🗑️', 'Clearing session, retrying in 10s...');
        isInitializing = false;
        try {
            if (fs.existsSync(SESSION_PATH)) {
                fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            }
        } catch (e) {}
        reconnectTimer = setTimeout(() => initializeClient(), 10000);
    });

    // ✅ Auto-reconnect
    client.on('disconnected', async (reason) => {
        log('⚠️', `Disconnected: ${reason} — reconnecting in 5s...`);
        isReady = false;
        isInitializing = false;
        await destroyClient();
        reconnectTimer = setTimeout(() => initializeClient(), 5000);
    });

    try {
        await client.initialize();
        log('✅', 'Client initialized');
    } catch (err) {
        log('❌', `Init error: ${err.message}`);
        isInitializing = false;
        log('🔄', 'Retrying in 15s...');
        reconnectTimer = setTimeout(() => initializeClient(), 15000);
    }
}

// ============ ROUTES ============

app.get('/', (req, res) => {
    res.json({
        service: 'MechTrack WhatsApp Bridge',
        status: isReady ? '✅ Connected' : isInitializing ? '⏳ Connecting...' : '❌ Disconnected',
        ready: isReady,
        railway_url: RAILWAY_API_URL
    });
});

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isReady,
        connecting: isInitializing,
        qr_available: !!currentQrBase64
    });
});

app.get('/status', (req, res) => {
    res.json({
        ready: isReady,
        connecting: isInitializing,
        qr_available: !!currentQrBase64
    });
});

app.get('/qr', async (req, res) => {
    if (isReady) return res.json({ ready: true, message: 'Already connected' });
    if (currentQrBase64) return res.json({
        qr: currentQrBase64,
        ready: false,
        timestamp: qrGeneratedAt   // ✅ HTML uses this to detect new QR
    });
    res.json({ qr: null, ready: false, connecting: isInitializing });
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    if (!isReady || !client) return res.status(503).json({ error: 'WhatsApp not ready', ready: isReady });

    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.substring(1);
    if (!clean.startsWith('91')) clean = '91' + clean;

    try {
        const chatId = `${clean}@c.us`;
        const numberDetails = await client.getNumberId(chatId);
        if (!numberDetails) return res.status(400).json({ error: 'Number not on WhatsApp' });
        const sent = await client.sendMessage(chatId, message);
        log('✅', `Message sent to ${clean}`);
        res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        log('❌', `Send error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    log('🔄', 'Resetting bridge...');
    await destroyClient();
    try {
        if (fs.existsSync(SESSION_PATH)) {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
        }
    } catch (e) {}
    setTimeout(() => initializeClient(), 2000);
    res.json({ success: true, message: 'Resetting — new QR generating' });
});

app.post('/disconnect', async (req, res) => {
    await destroyClient();
    res.json({ success: true });
});

// ============ START ============

app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `Bridge running on port ${PORT}`);
    log('🔗', `Railway URL: ${RAILWAY_API_URL}`);
    initializeClient();
});

process.on('SIGTERM', async () => {
    log('🛑', 'Shutting down...');
    await destroyClient();
    process.exit(0);
});
