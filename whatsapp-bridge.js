const { Client, LocalAuth } = require('whatsapp-web.js');
const express = require('express');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 4322;
const SESSION_PATH = path.join(__dirname, 'whatsapp-session');

// Your Railway URL
const RAILWAY_API_URL = process.env.RAILWAY_API_URL || "https://mech-production-30d8.up.railway.app";

let client = null;
let currentQr = null;
let currentQrBase64 = null;
let isReady = false;
let isInitializing = false;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon} ${msg}`);
}

async function destroyClient() {
    if (client) {
        try {
            await client.destroy();
        } catch (e) {}
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
            log('✅', 'QR pushed to Railway successfully!');
        } else {
            log('⚠️', `Railway returned: ${response.status}`);
        }
    } catch (err) {
        log('⚠️', `Failed to push QR: ${err.message}`);
    }
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
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions'
            ]
        }
    });

    client.on('qr', async (qr) => {
        log('📱', 'QR CODE GENERATED!');
        currentQr = qr;
        
        try {
            currentQrBase64 = await qrcode.toDataURL(qr, {
                margin: 2,
                width: 300,
                color: { dark: '#000000', light: '#FFFFFF' }
            });
            
            await pushQrToRailway(currentQrBase64);
            log('✅', 'QR ready for scanning');
        } catch (err) {
            log('❌', `QR error: ${err.message}`);
        }
    });

    client.on('ready', () => {
        log('🎉', 'WHATSAPP CONNECTED AND READY!');
        isReady = true;
        isInitializing = false;
        currentQr = null;
        
        fetch(`${RAILWAY_API_URL}/whatsapp/bridge-ready`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'ready' })
        }).catch(e => log('⚠️', 'Could not notify Railway'));
    });

    client.on('auth_failure', (msg) => {
        log('❌', `Auth failed: ${msg}`);
        isInitializing = false;
    });

    client.on('disconnected', (reason) => {
        log('⚠️', `Disconnected: ${reason}`);
        isReady = false;
        isInitializing = false;
        setTimeout(() => initializeClient(), 5000);
    });

    try {
        await client.initialize();
        log('✅', 'Client initialized');
    } catch (err) {
        log('❌', `Init error: ${err.message}`);
        isInitializing = false;
    }
}

// ============ EXPRESS ROUTES ============

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        ready: isReady, 
        qr_available: !!currentQrBase64,
        connecting: isInitializing 
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
    if (isReady) {
        res.json({ ready: true, message: 'Already connected' });
    } else if (currentQrBase64) {
        res.json({ qr: currentQrBase64, ready: false });
    } else {
        res.json({ qr: null, ready: false, connecting: isInitializing });
    }
});

app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message required' });
    }
    
    if (!isReady || !client) {
        return res.status(503).json({ error: 'WhatsApp not ready', ready: isReady });
    }

    let clean = phone.replace(/\D/g, '');
    if (clean.length === 10) clean = '91' + clean;
    if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.substring(1);
    if (!clean.startsWith('91')) clean = '91' + clean;

    try {
        const chatId = `${clean}@c.us`;
        const numberDetails = await client.getNumberId(chatId);
        
        if (!numberDetails) {
            return res.status(400).json({ error: 'Number not on WhatsApp' });
        }
        
        const sent = await client.sendMessage(chatId, message);
        log('✅', `Message sent to ${clean}`);
        res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        log('❌', `Send error: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    log('🔄', 'Resetting...');
    await destroyClient();
    
    if (fs.existsSync(SESSION_PATH)) {
        fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    }
    
    setTimeout(() => initializeClient(), 2000);
    res.json({ success: true });
});

app.post('/disconnect', async (req, res) => {
    await destroyClient();
    res.json({ success: true });
});

// Serve static files (for QR HTML page)
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `WhatsApp Bridge running on port ${PORT}`);
    log('🔗', `QR API: http://localhost:${PORT}/qr`);
    log('🔗', `Status: http://localhost:${PORT}/status`);
    log('🔗', `Railway URL: ${RAILWAY_API_URL}`);
    initializeClient();
});

process.on('SIGTERM', () => {
    log('🛑', 'Shutting down...');
    server.close(() => process.exit(0));
});
