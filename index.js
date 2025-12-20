const express = require('express');
const admin = require('firebase-admin');

// Инициализация Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.database();
const messaging = admin.messaging();

const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
    res.send('FlipFlap Server is running!');
});

// Слушаем новые сообщения
function startListening() {
    console.log('Starting to listen for new messages...');
    
    const messagesRef = db.ref('messages');
    
    messagesRef.on('child_added', (chatSnapshot) => {
        const chatId = chatSnapshot.key;
        
        // Слушаем сообщения в каждом чате
        db.ref(`messages/${chatId}`).on('child_added', async (msgSnapshot) => {
            const message = msgSnapshot.val();
            const messageId = msgSnapshot.key;
            
            // Проверяем, новое ли сообщение (не старше 30 секунд)
            const now = Date.now();
            if (!message.time || now - message.time > 30000) {
                return;
            }
            
            await sendNotification(chatId, message);
        });
    });
    
    // Также слушаем новые чаты
    db.ref('chats').on('child_added', (chatSnapshot) => {
        const chatId = chatSnapshot.key;
        
        db.ref(`messages/${chatId}`).on('child_added', async (msgSnapshot) => {
            const message = msgSnapshot.val();
            
            const now = Date.now();
            if (!message.time || now - message.time > 30000) {
                return;
            }
            
            await sendNotification(chatId, message);
        });
    });
}

async function sendNotification(chatId, message) {
    try {
        const senderId = message.senderId;
        const text = message.text;
        
        if (!senderId || !text) {
            return;
        }
        
        // Получаем чат
        const chatSnap = await db.ref(`chats/${chatId}`).once('value');
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
        const receiverSnap = await db.ref(`users/${receiverId}`).once('value');
        const receiver = receiverSnap.val();
        
        if (!receiver || !receiver.fcmToken) {
            console.log('No FCM token for receiver:', receiverId);
            return;
        }
        
        // Не отправляем если получатель онлайн
        // (можно убрать если хотите всегда отправлять)
        // if (receiver.online === true) {
        //     return;
        // }
        
        // Получаем имя отправителя
        const senderSnap = await db.ref(`users/${senderId}/name`).once('value');
        const senderName = senderSnap.val() || 'Новое сообщение';
        
        // Формируем уведомление
        const payload = {
            notification: {
                title: senderName,
                body: text.length > 100 ? text.substring(0, 100) + '...' : text
            },
            data: {
                title: senderName,
                body: text,
                chatId: chatId,
                senderId: senderId
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'default',
                    clickAction: 'OPEN_CHAT'
                }
            },
            token: receiver.fcmToken
        };
        
        const response = await messaging.send(payload);
        console.log('Notification sent:', senderName, '->', receiver.name);
        
    } catch (error) {
        if (error.code === 'messaging/registration-token-not-registered') {
            console.log('Token expired, removing...');
            // Можно удалить невалидный токен
        } else {
            console.error('Error sending notification:', error.message);
        }
    }
}

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    startListening();
});