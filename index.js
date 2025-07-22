const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

const client = new Client({
    authStrategy: new LocalAuth()
});

const app = express();
const PORT = 3000;
app.use(bodyParser.json());

const typingMap = new Map(); // Tracks typing indicators
const questionTracker = new Map(); // Tracks first question per group

// Endpoint to receive replies from n8n (can send plain text or buttons)
app.post('/send-reply', async (req, res) => {
    const { chatId, message, buttonText } = req.body;

    if (!chatId || !message) {
        return res.status(400).json({ error: 'Missing chatId or message' });
    }

    try {
        // Stop typing indicator if active
        const interval = typingMap.get(chatId);
        if (interval) {
            clearInterval(interval);
            typingMap.delete(chatId);
            const chat = await client.getChatById(chatId);
            await chat.clearState();
        }

        // Send button or plain text
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
        return res.status(200).json({ success: true });
    } catch (err) {
        console.error('❌ Failed to send message:', err);
        return res.status(500).json({ error: 'Failed to send message' });
    }
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🌐 Express server running at http://localhost:${PORT}`);
});

// Show QR code for authentication
client.on('qr', qr => {
    qrcode.generate(qr, { small: true });
    console.log("📲 Scan the QR code above with your WhatsApp.");
});

// WhatsApp ready
client.on('ready', () => {
    console.log('✅ WhatsApp bot is connected and ready!');
});

// Handle group messages and mentions
client.on('message', async message => {
    try {
        const chat = await message.getChat();
        if (!chat.isGroup) return;

        const chatId = chat.id._serialized;
        const botId = client.info.wid._serialized;

        // Manual reset
        if (message.body.toLowerCase().includes('reset bot')) {
            questionTracker.delete(chatId);
            console.log(`🔄 Question manually reset for group: ${chat.name}`);
            return;
        }

        // Bot mentioned
        if (message.mentionedIds.includes(botId)) {
            // Check if question already tracked
            if (questionTracker.has(chatId)) {
                console.log(`🟡 Bot mentioned again in ${chat.name}, but question already recorded.`);
                return;
            }

            // Save first mentioned message as the question
            questionTracker.set(chatId, {
                question: message.body,
                from: message.author || message.from,
                timestamp: message.timestamp
            });

            // Auto-reset after 5 minutes
            setTimeout(() => {
                questionTracker.delete(chatId);
                console.log(`🧹 Cleared tracked question after timeout for: ${chat.name}`);
            }, 5 * 60 * 1000); // 5 minutes

            // Start typing indicator
            await chat.sendStateTyping();

            const typingInterval = setInterval(() => {
                chat.sendStateTyping();
            }, 10000);
            typingMap.set(chatId, typingInterval);

            // Fetch recent messages
            const recentMessages = await chat.fetchMessages({ limit: 10 });
            const formattedMessages = recentMessages.map(m => ({
                from: m.author || m.from,
                body: m.body,
                timestamp: m.timestamp
            }));

            // Send to n8n webhook
            await axios.post('https://smartseasai.app.n8n.cloud/webhook-test/whatsapp-group', {
                groupName: chat.name,
                chatId: chatId,
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

// Start WhatsApp client
client.initialize();
