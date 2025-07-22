const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = 'superSecret123'; // 🔒 Change this before production

let currentQR = null;

app.use(bodyParser.json());

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox'],
        headless: true
    }
});

const typingMap = new Map();
const questionTracker = new Map();

// 📲 Display QR in terminal & store for web
client.on('qr', qr => {
    currentQR = qr;
    qrcode.generate(qr, { small: true });
    console.log("📲 Scan the QR code above with WhatsApp or visit /qr");
});

// ✅ WhatsApp ready
client.on('ready', () => {
    console.log('✅ WhatsApp bot is connected and ready!');
    currentQR = null;
});

// 🔁 Reset session (for re-authentication)
app.get('/reset-session', (req, res) => {
    if (req.query.token !== ADMIN_TOKEN) {
        return res.status(403).send('❌ Unauthorized');
    }

    try {
        const sessionPath = './.wwebjs_auth';
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('🔁 Session reset. Restarting...');
        res.send('✅ Session reset. Restart server to re-authenticate.');
    } catch (err) {
        console.error('❌ Failed to reset session:', err);
        res.status(500).send('❌ Failed to reset session.');
    }
});

// 🖼️ QR Code route
app.get('/qr', async (req, res) => {
    if (!currentQR) {
        return res.status(200).send('✅ Already authenticated or QR not available.');
    }

    try {
        const qrImage = await QRCode.toDataURL(currentQR);
        res.send(`
            <html>
                <head><title>Scan WhatsApp QR</title></head>
                <body style="text-align:center; font-family:sans-serif;">
                    <h2>📱 Scan this QR Code to Login</h2>
                    <img src="${qrImage}" />
                </body>
            </html>
        `);
    } catch (error) {
        res.status(500).send('❌ Failed to generate QR image.');
    }
});

// 🧠 Message handler
client.on('message', async message => {
    try {
        const chat = await message.getChat();
        if (!chat.isGroup) return;

        const chatId = chat.id._serialized;
        const botId = client.info.wid._serialized;

        if (message.body.toLowerCase().includes('reset bot')) {
            questionTracker.delete(chatId);
            console.log(`🔄 Question manually reset for group: ${chat.name}`);
            return;
        }

        if (message.mentionedIds.includes(botId)) {
            if (questionTracker.has(chatId)) {
                console.log(`🟡 Bot mentioned again in ${chat.name}, but question already recorded.`);
                return;
            }

            questionTracker.set(chatId, {
                question: message.body,
                from: message.author || message.from,
                timestamp: message.timestamp
            });

            setTimeout(() => {
                questionTracker.delete(chatId);
                console.log(`🧹 Cleared tracked question after timeout for: ${chat.name}`);
            }, 5 * 60 * 1000);

            await chat.sendStateTyping();
            const typingInterval = setInterval(() => {
                chat.sendStateTyping();
            }, 10000);
            typingMap.set(chatId, typingInterval);

            const recentMessages = await chat.fetchMessages({ limit: 10 });
            const formattedMessages = recentMessages.map(m => ({
                from: m.author || m.from,
                body: m.body,
                timestamp: m.timestamp
            }));

            await axios.post('https://smartseasai.app.n8n.cloud/webhook-test/whatsapp-group', {
                groupName: chat.name,
                chatId,
                triggeredBy: message.author || message.from,
                question: message.body,
                messages: formattedMessages
            });

            console.log(`✅ Recorded first question from ${chat.name}: ${message.body}`);
        }
    } catch (err) {
        console.error('❌ Error in group message handling:', err);
    }
});

// 📩 Reply handler
app.post('/send-reply', async (req, res) => {
    const { chatId, message, buttonText } = req.body;

    if (!chatId || !message) {
        return res.status(400).json({ error: 'Missing chatId or message' });
    }

    try {
        const interval = typingMap.get(chatId);
        if (interval) {
            clearInterval(interval);
            typingMap.delete(chatId);
            const chat = await client.getChatById(chatId);
            await chat.clearState();
        }

        if (buttonText) {
            await client.sendMessage(chatId, {
                text: message,
                buttons: [
                    {
                        type: 'reply',
                        reply: {
                            id: 'btn_1',
                            title: buttonText
                        }
                    }
                ],
                headerType: 1
            });
        } else {
            await client.sendMessage(chatId, message);
        }

        console.log(`✅ Replied to ${chatId}: ${message}`);
        res.status(200).json({ success: true });
    } catch (err) {
        console.error('❌ Failed to send message:', err);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// 🌐 Root status
app.get('/', (req, res) => {
    res.send('🟢 WhatsApp Bot is running!');
});

// 🚀 Start server
app.listen(PORT, () => {
    console.log(`🌍 Express server running at http://localhost:${PORT}`);
});

// ▶️ Start WhatsApp client
client.initialize();
