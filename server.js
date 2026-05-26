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
    userId: { type: String, required: true, unique: true },
    hostelName: { type: String, required: true },
    fcmTokens: [{ type: String }]
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
            { 
                $set: { hostelName },
                $addToSet: { fcmTokens: fcmToken } 
            },
            { upsert: true, returnDocument: 'after' }
        );

        console.log(`[Database] Successfully saved token for User: ${userId} in ${hostelName}`);

        return res.status(200).json({ success: true, data: synchronizedDevice });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false });
    }
});

app.post('/api/notifications/trigger', async (req, res) => {
    try {
        const { hostelName, initiatorId } = req.body;

        if (!hostelName || !initiatorId) {
            return res.status(400).json({ success: false });
        }

        const targetUsers = await DeviceToken.find({ hostelName, userId: { $ne: initiatorId } });
        
        let tokensList = [];
        targetUsers.forEach(user => {
            if (user.fcmTokens && user.fcmTokens.length > 0) {
                tokensList = tokensList.concat(user.fcmTokens);
            }
        });

        tokensList = [...new Set(tokensList)];

        if (tokensList.length === 0) {
            console.log(`[Firebase] No other users found to notify in ${hostelName}.`);
            return res.status(200).json({ success: true, message: 'No targets found' });
        }

        const messagePayload = {
            data: {
                title: `Order Alert in ${hostelName}!`,
                body: 'Someone just initiated an order. Open the app to pool items!',
                link: "https://instantpal-client.onrender.com/dashboard"
            },
            webpush: {
                headers: {
                    Urgency: "high"
                }
            },
            tokens: tokensList 
        };

        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(tokensList[idx]);
                }
            });
            if (failedTokens.length > 0) {
                await DeviceToken.updateMany(
                    { fcmTokens: { $in: failedTokens } },
                    { $pull: { fcmTokens: { $in: failedTokens } } }
                );
            }
        }
        
        console.log(`[Firebase] Broadcast sent for ${hostelName}. Success: ${response.successCount}, Failed: ${response.failureCount}`);
        
        return res.status(200).json({
            success: true,
            successCount: response.successCount,
            failureCount: response.failureCount
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false });
    }
});

app.post('/api/notifications/notify-user', async (req, res) => {
    try {
        const { targetUserId, title, body } = req.body;

        if (!targetUserId || !title || !body) {
            return res.status(400).json({ success: false });
        }

        const targetUser = await DeviceToken.findOne({ userId: targetUserId });

        if (!targetUser || !targetUser.fcmTokens || targetUser.fcmTokens.length === 0) {
            return res.status(404).json({ success: false });
        }

        const tokensList = [...new Set(targetUser.fcmTokens)];

        const messagePayload = {
            data: { 
                title: title, 
                body: body,
                link: "https://instantpal-client.onrender.com/dashboard"
            },
            webpush: {
                headers: {
                    Urgency: "high"
                }
            },
            tokens: tokensList
        };

        const response = await admin.messaging().sendEachForMulticast(messagePayload);
        
        if (response.failureCount > 0) {
            const failedTokens = [];
            response.responses.forEach((resp, idx) => {
                if (!resp.success) {
                    failedTokens.push(tokensList[idx]);
                }
            });
            if (failedTokens.length > 0) {
                await DeviceToken.updateOne(
                    { userId: targetUserId },
                    { $pull: { fcmTokens: { $in: failedTokens } } }
                );
            }
        }
        
        console.log(`[Firebase] DM sent to User ${targetUserId}. Success: ${response.successCount}`);
        return res.status(200).json({ success: true });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false });
    }
});

app.get('/api/health', (req, res) => {
    res.status(200).send('OK');
});

const PORT = process.env.PORT || 5001;
app.listen(PORT, () => console.log(`Notification Microservice running on port ${PORT}`));
