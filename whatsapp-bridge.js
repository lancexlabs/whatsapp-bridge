const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = 4322;
const SESSION_PATH = path.join(__dirname, 'whatsapp-session');
const QR_IMAGE_PATH = path.join(__dirname, 'public', 'whatsapp-qr.png');

const RAILWAY_URL = "https://mech-production-30d8.up.railway.app";

if (!fs.existsSync(path.join(__dirname, 'public'))) {
    fs.mkdirSync(path.join(__dirname, 'public'), { recursive: true });
}

let client = null;
let currentQr = null;
let currentQrBase64 = null;
let isReady = false;
let isInitializing = false;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon}  ${msg}`);
}

async function saveQrAsImage(qrData) {
    try {
        await qrcode.toFile(QR_IMAGE_PATH, qrData, {
            margin: 2,
            width: 400,
            color: { dark: '#000000', light: '#FFFFFF' }
        });
        currentQrBase64 = await qrcode.toDataURL(qrData, {
            margin: 2,
            width: 300
        });
        log('💾', 'QR saved as image');
        return true;
    } catch (err) {
        log('❌', `Failed to save QR: ${err.message}`);
        return false;
    }
}

async function pushQrToRailway(qrBase64) {
    try {
        log('☁️', 'Pushing QR to Railway...');
        const response = await fetch(`${RAILWAY_URL}/whatsapp/push-qr`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ qr: qrBase64 })
        });
        if (response.ok) {
            log('✅', `QR pushed to Railway!`);
            log('📱', `Client can scan at: ${RAILWAY_URL}/whatsapp/qr`);
        } else {
            log('⚠️', `Railway returned: ${response.status}`);
        }
    } catch (err) {
        log('⚠️', `Failed to push QR to Railway: ${err.message}`);
    }
}

async function destroyClient() {
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
            timeout: 90000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
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

    client.on('qr', async (qr) => {
        log('📱', 'QR received!');
        currentQr = qr;
        await saveQrAsImage(qr);
        qrcodeTerminal.generate(qr, { small: true });
        log('💡', `Local QR: http://localhost:4322/whatsapp-qr-image`);
        if (currentQrBase64) {
            await pushQrToRailway(currentQrBase64);
        }
    });

    client.on('authenticated', () => {
        log('✅', 'Authentication successful');
    });

    client.on('ready', () => {
        log('🎉', 'WhatsApp READY and ONLINE!');
        log('📱', 'Bridge will stay online to receive/send messages');
        isReady = true;
        isInitializing = false;
        currentQr = null;
        // ✅ REMOVED - Don't exit! Keep running
    });

    client.on('auth_failure', (msg) => {
        log('❌', `Auth failed: ${msg}`);
        isInitializing = false;
    });

    client.on('disconnected', (reason) => {
        log('⚠️', `Disconnected: ${reason}`);
        isReady = false;
        isInitializing = false;
        // Optionally auto-reconnect after 10 seconds
        setTimeout(() => {
            log('🔄', 'Attempting to reconnect...');
            initializeClient();
        }, 10000);
    });

    try {
        await client.initialize();
    } catch (err) {
        log('❌', `Init error: ${err.message}`);
        isInitializing = false;
    }
}

// Routes
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        ready: isReady,
        connecting: isInitializing
    });
});

app.get('/status', (req, res) => {
    res.json({
        ready: isReady,
        connecting: isInitializing
    });
});

app.get('/qr', async (req, res) => {
    if (isReady) {
        return res.json({ qr: null, ready: true });
    }
    if (currentQrBase64) {
        return res.json({ qr: currentQrBase64, ready: false });
    }
    if (currentQr) {
        try {
            const url = await qrcode.toDataURL(currentQr, { margin: 2, width: 300 });
            currentQrBase64 = url;
            return res.json({ qr: url, ready: false });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }
    res.json({ qr: null, ready: false, connecting: isInitializing });
});

app.get('/qr-info', (req, res) => {
    const qrExists = fs.existsSync(QR_IMAGE_PATH);
    res.json({
        qr_available: qrExists && !isReady,
        qr_path: qrExists ? '/whatsapp-qr-image' : null,
        is_connected: isReady,
        is_connecting: isInitializing
    });
});

app.get('/whatsapp-qr-image', (req, res) => {
    if (fs.existsSync(QR_IMAGE_PATH) && !isReady) {
        res.sendFile(QR_IMAGE_PATH);
    } else {
        res.status(404).json({ error: 'QR not available' });
    }
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!phone || !message) return res.status(400).json({ error: 'Phone and message required' });
    
    if (!isReady || !client) {
        log('❌', 'Cannot send - WhatsApp not ready');
        return res.status(503).json({ error: 'WhatsApp not ready', ready: isReady });
    }

    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (!clean.startsWith('91')) clean = '91' + clean;

    try {
        log('📤', `Sending to ${clean}...`);
        const chatId = `${clean}@c.us`;
        const numberDetails = await client.getNumberId(chatId);
        if (!numberDetails) {
            log('⚠️', `Number ${clean} not on WhatsApp`);
            return res.status(400).json({ error: 'Number not on WhatsApp' });
        }
        const sent = await client.sendMessage(chatId, message);
        log('✅', `Message sent! ID: ${sent.id.id}`);
        return res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        log('❌', `Send error: ${err.message}`);
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
        await destroyClient();
        setTimeout(() => initializeClient(), 1000);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Start server and initialize
const server = app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `Bridge running on port ${PORT}`);
    log('☁️', `Will push QR to: ${RAILWAY_URL}`);
    initializeClient();
});

process.on('SIGINT', () => {
    log('🛑', 'Shutting down...');
    server.close(() => process.exit(0));
});

