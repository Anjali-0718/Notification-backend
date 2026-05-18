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

// 1. Handle Firebase credentials securely across environments
let firebaseCredentials;

if (process.env.FIREBASE_CREDENTIALS) {
    // Production (Render): Parse the raw environment variable string back to JSON
    firebaseCredentials = JSON.parse(process.env.FIREBASE_CREDENTIALS);
} else {
    // Development (Local Machine): Read safely from your local credentials file
    firebaseCredentials = JSON.parse(
        readFileSync(new URL('./firebase-credentials.json', import.meta.url))
    );
}

admin.initializeApp({
    credential: admin.credential.cert(firebaseCredentials)
});

// 2. Establish MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Notification Database Connected Successfully'))
    .catch(err => console.error('Database Connection Error:', err));

// 3. Setup Token Document Model Schema
const tokenSchema = new mongoose.Schema({
    userId: { type: String, required: true },
    hostelName: { type: String, required: true },
    fcmToken: { type: String, required: true, unique: true }
});

const DeviceToken = mongoose.model('DeviceToken', tokenSchema);

// 4. API Route A: Register/Sync device browser tokens
app.post('/api/devices/register', async (req, res) => {
    try {
        const { userId, hostelName, fcmToken } = req.body;

        if (!userId || !hostelName || !fcmToken) {
            return res.status(400).json({ success: false, message: 'Missing parameters.' });
        }

        // Upsert syntax: updates database if device token exists, otherwise registers a new entry
        const synchronizedDevice = await DeviceToken.findOneAndUpdate(
            { fcmToken },
            { userId, hostelName },
            { upsert: true, new: true }
        );

        return res.status(200).json({ success: true, data: synchronizedDevice });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

// 5. API Route B: Broadcast alert notifications to a specific hostel group
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

        // Payload format
        const messagePayload = {
            notification: {
                title: `Order Alert in ${hostelName}!`,
                body: 'Someone just initiated an order. Open the app to pool items!'
            },
            tokens: tokensList 
        };

        // Firebase multicast delivery
        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        
        return res.status(200).json({
            success: true,
            successCount: response.successCount,
            failureCount: response.failureCount
        });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Notification Microservice running on port ${PORT}`));