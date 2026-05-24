import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import admin from 'firebase-admin';
import { readFileSync } from 'fs';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

let firebaseCredentials;

if (process.env.FIREBASE_CREDENTIALS) {
    firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
    firebaseCredentials = JSON.parse(
        readFileSync(new URL('./firebase-credentials.json', import.meta.url))
    );
}

admin.initializeApp({
    credential: admin.credential.cert(firebaseCredentials)
});

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Notification Database Connected Successfully'))
    .catch(err => console.error('Database Connection Error:', err));

const tokenSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    hostelName: { type: String, required: true },
    fcmToken: { type: String, required: true, unique: true }
}, { timestamps: true });

const DeviceToken = mongoose.model('DeviceToken', tokenSchema);

app.post('/api/devices/register', async (req, res) => {
    try {
        const { userId, hostelName, fcmToken } = req.body;

        if (!userId || !hostelName || !fcmToken) {
            return res.status(400).json({ success: false, message: 'Missing parameters.' });
        }

        const synchronizedDevice = await DeviceToken.findOneAndUpdate(
            { userId },
            { fcmToken, hostelName },
            { upsert: true, returnDocument: 'after' }
        );

        console.log(`[Database] Successfully saved token for User: ${userId} in ${hostelName}`);

        return res.status(200).json({ success: true, data: synchronizedDevice });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/notifications/trigger', async (req, res) => {
    try {
        const { hostelName, initiatorId } = req.body;

        if (!hostelName || !initiatorId) {
            return res.status(400).json({ success: false, message: 'Missing hostelName or initiatorId.' });
        }

        const targetDevices = await DeviceToken.find({ hostelName, userId: { $ne: initiatorId } });
        const tokensList = targetDevices.map(device => device.fcmToken);

        if (tokensList.length === 0) {
            return res.status(200).json({ success: true, message: 'No other devices active in this hostel.' });
        }

        const messagePayload = {
            notification: {
                title: `Order Alert in ${hostelName}!`,
                body: 'Someone just initiated an order. Open the app to pool items!'
            },
            webpush: {
                // ✅ ADDED: Forces the OS to wake up the app even if swiped away
                headers: {
                    Urgency: "high"
                },
                fcmOptions: {
                    link: "https://instantpal.vercel.app"
                }
            },
            tokens: tokensList 
        };

        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        
        console.log(`[Firebase] Broadcast sent for ${hostelName}. Success: ${response.successCount}, Failed: ${response.failureCount}`);
        
        return res.status(200).json({
            success: true,
            successCount: response.successCount,
            failureCount: response.failureCount
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/notifications/notify-user', async (req, res) => {
    try {
        const { targetUserId, title, body } = req.body;

        if (!targetUserId || !title || !body) {
            return res.status(400).json({ success: false, message: 'Missing required fields' });
        }

        const userTokens = await DeviceToken.find({ userId: targetUserId });
        const tokensList = userTokens.map(doc => doc.fcmToken);

        if (tokensList.length === 0) {
            return res.status(404).json({ success: false, message: 'User has no registered devices' });
        }

        const messagePayload = {
            notification: { title, body },
            webpush: {
                // ✅ ADDED: Forces the OS to wake up the app even if swiped away
                headers: {
                    Urgency: "high"
                },
                fcmOptions: {
                    link: "https://instantpal.vercel.app"
                }
            },
            tokens: tokensList
        };

        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        
        console.log(`[Firebase] DM sent to User ${targetUserId}. Success: ${response.successCount}`);
        return res.status(200).json({ success: true, response });

    } catch (error) {
        console.error("[Firebase] DM Error:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Notification Microservice running on port ${PORT}`));
