const express = require('express');
const admin = require('firebase-admin');
const https = require('https');

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const messaging = admin.messaging();

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
    res.json({ status: 'running', time: new Date().toISOString() });
});

// Храним отправленные уведомления
const sentMessages = new Set();
const sentCalls = new Set();

// Очищаем каждый час
setInterval(() => {
    sentMessages.clear();
    sentCalls.clear();
    console.log('Cache cleared');
}, 60 * 60 * 1000);

function startListening() {
    console.log('Starting listener...');
    
    // Слушаем сообщения
    db.ref('messages').on('child_added', (chatSnap) => {
        const chatId = chatSnap.key;
        listenToChat(chatId);
    });

    db.ref('messages').once('value', (snap) => {
        snap.forEach((chatSnap) => {
            const chatId = chatSnap.key;
            listenToChat(chatId);
        });
        console.log('Listening to ' + snap.numChildren() + ' existing chats');
    });

    // Слушаем звонки
    listenToCalls();
    
    console.log('Listener started!');
}

// ============ ЗВОНКИ ============
function listenToCalls() {
    console.log('Starting calls listener...');
    
    db.ref('calls').on('child_added', async (callSnap) => {
        const call = callSnap.val();
        const callId = callSnap.key;
        
        // Проверяем что это новый звонок
        if (call.status !== 'calling') {
            return;
        }
        
        // Проверяем что не старше 30 секунд
        const now = Date.now();
        if (call.timestamp && (now - call.timestamp > 30000)) {
            return;
        }
        
        // Проверяем дубликаты
        if (sentCalls.has(callId)) {
            return;
        }
        sentCalls.add(callId);
        
        console.log('New call: ' + callId);
        await sendCallNotification(callId, call);
    });
    
    console.log('Calls listener started!');
}

async function sendCallNotification(callId, call) {
    try {
        const callerId = call.callerId;
        const receiverId = call.receiverId;
        const isVideo = call.isVideo || false;
        
        if (!callerId || !receiverId) {
            console.log('Missing caller or receiver');
            return;
        }
        
        // Получаем токен получателя
        const receiverSnap = await db.ref('users/' + receiverId).once('value');
        const receiver = receiverSnap.val();
        
        if (!receiver || !receiver.fcmToken) {
            console.log('No FCM token for: ' + receiverId);
            return;
        }
        
        // Получаем имя звонящего
        const callerSnap = await db.ref('users/' + callerId + '/name').once('value');
        const callerName = callerSnap.val() || 'Неизвестный';
        
        // Отправляем push
        await messaging.send({
            data: {
                type: 'incoming_call',
                callId: callId,
                callerId: callerId,
                callerName: callerName,
                isVideo: String(isVideo)
            },
            android: {
                priority: 'high',
                ttl: 30000
            },
            token: receiver.fcmToken
        });
        
        console.log('CALL: ' + callerName + ' -> ' + (receiver.name || receiverId));
        
    } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
            console.log('Token expired for call');
        } else {
            console.error('Call error: ' + err.message);
        }
    }
}

// ============ СООБЩЕНИЯ ============
const activeListeners = new Set();

function listenToChat(chatId) {
    if (activeListeners.has(chatId)) {
        return;
    }
    activeListeners.add(chatId);

    db.ref('messages/' + chatId).on('child_added', (msgSnap) => {
        const message = msgSnap.val();
        const messageId = msgSnap.key;

        const now = Date.now();
        if (message.time && (now - message.time > 60000)) {
            return;
        }

        const key = chatId + '_' + messageId;
        if (sentMessages.has(key)) {
            return;
        }
        sentMessages.add(key);

        sendNotification(chatId, message);
    });
}

async function sendNotification(chatId, message) {
    try {
        const senderId = message.senderId;
        const text = message.text;

        if (!senderId || !text) {
            return;
        }

        const chatSnap = await db.ref('chats/' + chatId).once('value');
        const chat = chatSnap.val();

        if (!chat || !chat.members) {
            console.log('Chat not found: ' + chatId);
            return;
        }

        let receiverId = null;
        for (const uid in chat.members) {
            if (uid !== senderId) {
                receiverId = uid;
                break;
            }
        }

        if (!receiverId) {
            return;
        }

        if (message.deletedFor && message.deletedFor[receiverId]) {
            return;
        }

        const receiverSnap = await db.ref('users/' + receiverId).once('value');
        const receiver = receiverSnap.val();

        if (!receiver || !receiver.fcmToken) {
            console.log('No token for: ' + receiverId);
            return;
        }

        const senderSnap = await db.ref('users/' + senderId + '/name').once('value');
        const senderName = senderSnap.val() || 'Сообщение';

        await messaging.send({
            notification: {
                title: senderName,
                body: text.length > 100 ? text.slice(0, 100) + '...' : text
            },
            data: {
                chatId: chatId,
                senderId: senderId
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    channelId: 'messages'
                }
            },
            token: receiver.fcmToken
        });

        console.log('MSG: ' + senderName + ' -> ' + receiver.name + ': ' + text.slice(0, 30));

    } catch (err) {
        if (err.code === 'messaging/registration-token-not-registered') {
            console.log('Token expired');
        } else {
            console.error('Error: ' + err.message);
        }
    }
}

// Keep alive
function keepAlive() {
    const url = process.env.RENDER_EXTERNAL_URL;
    if (url) {
        setInterval(() => {
            https.get(url, () => {}).on('error', () => {});
        }, 14 * 60 * 1000);
    }
}

app.listen(PORT, () => {
    console.log('Server on port ' + PORT);
    startListening();
    keepAlive();
});
