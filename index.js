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

// Очищаем каждый час
setInterval(() => {
    sentMessages.clear();
    console.log('Cache cleared');
}, 60 * 60 * 1000);

// Храним активные listeners чтобы не дублировать
const activeListeners = new Set();

function startListening() {
    console.log('Starting listener...');
    
    // Слушаем ВСЕ сообщения одним listener'ом
    db.ref('messages').on('child_added', (chatSnap) => {
        const chatId = chatSnap.key;
        
        // Проверяем, не слушаем ли уже этот чат
        if (activeListeners.has(chatId)) {
            return;
        }
        activeListeners.add(chatId);
        
        // Слушаем только НОВЫЕ сообщения (после текущего времени)
        const startTime = Date.now();
        
        db.ref('messages/' + chatId)
            .orderByChild('time')
            .startAt(startTime)
            .on('child_added', (msgSnap) => {
                handleNewMessage(chatId, msgSnap.key, msgSnap.val());
            });
    });
    
    console.log('Listener started!');
}

async function handleNewMessage(chatId, messageId, message) {
    // Уникальный ключ для проверки дубликатов
    const key = chatId + '_' + messageId;
    
    // Если уже отправляли - пропускаем
    if (sentMessages.has(key)) {
        return;
    }
    
    // Сразу добавляем в отправленные
    sentMessages.add(key);
    
    // Отправляем уведомление
    await sendNotification(chatId, message);
}

async function sendNotification(chatId, message) {
    try {
        const senderId = message.senderId;
        const text = message.text;
        
        if (!senderId || !text) {
            return;
        }
        
        // Получаем чат
        const chatSnap = await db.ref('chats/' + chatId).once('value');
        const chat = chatSnap.val();
        
        if (!chat || !chat.members) {
            return;
        }
        
        // Находим получателя
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
        
        // Проверяем deletedFor
        if (message.deletedFor && message.deletedFor[receiverId]) {
            return;
        }
        
        // Получаем данные получателя
        const receiverSnap = await db.ref('users/' + receiverId).once('value');
        const receiver = receiverSnap.val();
        
        if (!receiver || !receiver.fcmToken) {
            console.log('No token for: ' + receiverId);
            return;
        }
        
        // Получаем имя отправителя
        const senderSnap = await db.ref('users/' + senderId + '/name').once('value');
        const senderName = senderSnap.val() || 'Сообщение';
        
        // Отправляем
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
        
        console.log('OK: ' + senderName + ' -> ' + receiver.name + ': ' + text.slice(0, 30));
        
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
