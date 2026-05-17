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
let isReady = false;
let isInitializing = false;
let qrGenerationAttempts = 0;

function log(icon, msg) {
    const ts = new Date().toLocaleTimeString('en-IN');
    console.log(`[${ts}] ${icon} ${msg}`);
}

// Force QR generation by restarting if no QR after 30 seconds
setInterval(() => {
    if (!isReady && !currentQr && isInitializing) {
        qrGenerationAttempts++;
        log('⚠️', `No QR yet (attempt ${qrGenerationAttempts})...`);
        
        if (qrGenerationAttempts > 6) { // 3 minutes
            log('🔄', 'Restarting client to generate QR...');
            destroyClient();
            setTimeout(() => initializeClient(), 2000);
            qrGenerationAttempts = 0;
        }
    }
}, 30000);

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

async function initializeClient() {
    if (isInitializing) {
        log('⏳', 'Already initializing...');
        return;
    }

    isInitializing = true;
    qrGenerationAttempts = 0;
    log('🚀', 'Starting WhatsApp client...');

    // Clear old session to force new QR
    if (fs.existsSync(SESSION_PATH)) {
        try {
            fs.rmSync(SESSION_PATH, { recursive: true, force: true });
            log('🗑️', 'Cleared old session for fresh QR');
        } catch(e) {}
    }

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
        log('📱', '✅ QR CODE GENERATED!');
        currentQr = qr;
        
        // Generate QR as data URL
        try {
            const qrDataUrl = await qrcode.toDataURL(qr, {
                margin: 2,
                width: 300,
                color: { dark: '#000000', light: '#FFFFFF' }
            });
            
            // Push to Railway
            log('☁️', 'Pushing QR to Railway...');
            const response = await fetch(`${RAILWAY_API_URL}/whatsapp/push-qr`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    qr: qrDataUrl,
                    timestamp: new Date().toISOString(),
                    raw_qr: qr.substring(0, 100) // First 100 chars for debug
                })
            });
            
            if (response.ok) {
                log('✅', 'QR successfully sent to Railway!');
                log('📱', 'Client can now scan QR from the web interface');
            } else {
                const error = await response.text();
                log('❌', `Railway returned: ${response.status} - ${error}`);
            }
        } catch (err) {
            log('❌', `Failed to process QR: ${err.message}`);
        }
        
        // Also log to console for terminal viewing
        console.log('\n📱 SCAN THIS QR CODE WITH WHATSAPP:\n');
        const terminalQr = require('qrcode-terminal');
        terminalQr.generate(qr, { small: true });
        console.log('\n');
    });

    client.on('ready', () => {
        log('🎉', '✅ WHATSAPP CONNECTED AND READY!');
        isReady = true;
        isInitializing = false;
        currentQr = null;
        
        // Notify Railway
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
        log('✅', 'Client initialized, waiting for QR...');
    } catch (err) {
        log('❌', `Init error: ${err.message}`);
        isInitializing = false;
    }
}

// Simple routes
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        ready: isReady, 
        qr_available: !!currentQr,
        connecting: isInitializing 
    });
});

app.get('/qr', (req, res) => {
    if (isReady) {
        res.json({ ready: true, message: 'Already connected' });
    } else if (currentQr) {
        qrcode.toDataURL(currentQr, { margin: 2, width: 300 }).then(qrUrl => {
            res.json({ qr: qrUrl, ready: false });
        }).catch(err => {
            res.status(500).json({ error: err.message });
        });
    } else {
        res.json({ qr: null, ready: false, connecting: isInitializing });
    }
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
        log('✅', `Message sent to ${clean}`);
        res.json({ success: true, messageId: sent.id.id });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/reset', async (req, res) => {
    log('🔄', 'Resetting...');
    await destroyClient();
    setTimeout(() => initializeClient(), 1000);
    res.json({ success: true });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    log('🚀', `Bridge running on port ${PORT}`);
    log('🔗', `Railway URL: ${RAILWAY_API_URL}`);
    initializeClient();
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
