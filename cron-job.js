const express = require('express');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
require('dotenv').config();
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r9pshpu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

// The hourly task logic
app.get('/api/cron/hourly-task', async (req, res) => {
    try {
        await client.connect();
        const eventCollection = client.db("eventUpDB").collection("events");
        const now = new Date();
        const localNow = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
        await eventCollection.updateMany(
            {
                date: { $lt: localNow.toISOString() },
                status: 'upcoming'
            },
            {
                $set: { status: 'ongoing' }
            }
        );
        const ongoingEvents = await eventCollection.find({ status: 'ongoing' }).toArray();
        
        for (const event of ongoingEvents) {
            const eventDate = new Date(event.date);
            const eventEndTime = new Date(eventDate.getTime() + event.duration * 60000); 
            
            if (localNow >= eventEndTime) {
                await eventCollection.updateOne(
                    { _id: event._id },
                    { $set: { status: 'completed' } }
                );
            }
        }
        res.status(200).send('Hourly task executed successfully.');
    } catch (error) {
        console.error('Error executing hourly task:', error);
        res.status(500).send('Error executing hourly task.');
    } finally {
        await client.close();
    }
});

// The daily task logic
app.get('/api/cron/daily-task', async (req, res) => {
    try {
        await client.connect();
        const eventCollection = client.db("eventUpDB").collection("events");
        const userCollection = client.db("eventUpDB").collection("users");
        const notificationCollection = client.db("eventUpDB").collection("notifications");

        const completedEvents = await eventCollection.find({
            status: 'completed',
            $or: [{ checked: false }, { checked: { $exists: false } }]
        }).toArray();
            
        for (const event of completedEvents) {
            for (const volunteer of event.volunteers) {
                if (volunteer?.isPresent === false || volunteer?.isPresent === undefined) {
                    const user = await userCollection.findOne({ email: volunteer.email });
                    if(user?.role === 'admin') continue;
                    if (user) {
                        let newWarningCount = (user?.warnings || 0) + 1;
                        let notificationMessage = '';
                        let explanation = '';
                        let banUntil = user.banUntil || null;

                        if (newWarningCount === 1) {
                            notificationMessage = 'You missed an event!';
                            explanation = `You have received a warning for not attending the event titled "${event.title}". Please remember to attend future events.`;
                        } else if (newWarningCount === 2) {
                            notificationMessage = 'Second warning received and a temporary ban!';
                            explanation = `This is your second warning for not attending the event titled "${event.title}". As a result, you are temporarily banned from registering for events for 10 days.`;
                            const banDate = new Date();
                            banDate.setDate(banDate.getDate() + 10);
                            banUntil = banDate;
                        } else if (newWarningCount === 3) {
                            notificationMessage = 'Third warning received and a temporary ban!';
                            explanation = `This is your third and final warning for not attending the event titled "${event.title}". You are temporarily banned from registering for events for 20 days. Further absences will result in a permanent ban.`;
                            const banDate = new Date();
                            banDate.setDate(banDate.getDate() + 20);
                            banUntil = banDate;
                        } else {
                            notificationMessage = 'Permanently banned.';
                            explanation= `You have been permanently banned from registering for events due to repeated absences, including the event titled "${event.title}`;
                            await userCollection.updateOne(
                                { email: user.email },
                                { $set: { isPermanentlyBanned: true } }
                            );
                        }
                        
                        await userCollection.updateOne(
                            { email: user.email },
                            {
                                $set: {
                                    warnings: newWarningCount,
                                    banUntil: banUntil
                                }
                            }
                        );

                        const notification = {
                            email: user.email,
                            message: notificationMessage,
                            reason: explanation,
                            type: 'warning',
                            read: false,
                            toastShown: false,
                            timestamp: new Date()
                        };
                        await notificationCollection.insertOne(notification);
                    }
                }
            }
            await eventCollection.updateOne(
                { _id: event._id },
                { $set: { checked: true } }
            );
        }
        res.status(200).send('Daily task executed successfully.');
    } catch (error) {
        console.error('Error executing daily task:', error);
        res.status(500).send('Error executing daily task.');
    } finally {
        await client.close();
    }
});

module.exports = app;