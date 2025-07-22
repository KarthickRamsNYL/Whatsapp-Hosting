const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');

const app = express();
const PORT = process.env.PORT || 3000;

let currentQR = null;

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox'],
        headless: true
    }
});

app.use(bodyParser.json());

const typingMap = new Map();
const questionTracker = new Map();

// 📲 Show QR when available
client.on('qr', qr => {
    currentQR = qr;
    qrcode.generate(qr, { small: true });
    console.log("📲 Scan the QR code above with your WhatsApp.");
});

// ✅ WhatsApp ready
client.on('ready', () => {
    console.log('✅ WhatsApp bot is connected and ready!');
    currentQR = null; // Clear QR once connected
});

// 📩 Endpoint for replies from n8n
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

// 🔎 Show QR code string (for Postman/browser)
app.get('/qr', (req, res) => {
    if (currentQR) {
        return res.status(200).send(`Scan this QR with WhatsApp: ${currentQR}`);
    } else {
        return res.status(200).send('✅ Already authenticated or QR not available.');
    }
});

// 🧠 Message handling
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

// 🌐 Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Express server running at http://localhost:${PORT}`);
});

// ▶️ Start WhatsApp client
client.initialize();
