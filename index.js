const express = require('express');
const app = express();
const cors = require('cors');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
require('dotenv').config();
const port = process.env.port || 5000;

//middleware
app.use(cors());
app.use(express.json());



const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r9pshpu.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const userCollection = client.db("eventUpDB").collection("users");
    const eventCollection = client.db("eventUpDB").collection("events");
    const reviewCollection = client.db("eventUpDB").collection("reviews");
    const notificationCollection = client.db("eventUpDB").collection("notifications");
    const commentCollection = client.db("eventUpDB").collection("comments");
    const activityCollection = client.db("eventUpDB").collection("activities");

    // --------------Middlewares----------------
    const generateSecretCode = () => {
        // Generates a random 8-character alphanumeric string
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    };
    const verifyToken=(req,res,next)=>{
        if(!req?.headers?.authorization){
        return res.status(401).send({message:'Unauthorized access'})
      }
      const token = req.headers.authorization?.split(' ')[1];
      jwt.verify(token, process.env.SECRET_ACCESS_TOKEN, (err, decoded)=>{
        if(err){
          return res.status(401).send({message:'Unauthorized access'});
        }
        req.decoded = decoded;
        next();
      })
    }
    const verifyAdmin = async(req, res, next) =>{
        const email = req.decoded?.email;
        const query = { email : email };
        const user = await userCollection.findOne(query);
        const isAdmin = user?.role === 'admin';
        if(!isAdmin){
          return res.status(403).send({message:'Forbidden Access'})
        }
        next();
    }
    const verifyOrganizer = async(req, res, next)=>{
      const email = req.decoded?.email;
      const query = { email : email };
      const user = await userCollection.findOne(query);
      const isOrganizer = user?.role === 'organizer' || user?.role === 'admin';
      if(!isOrganizer){
        return res.status(403).send({message:'Forbidden Access'})
      }
      next();
    }

    // ---------------JWT RELATED API------------------------
    app.post('/jwt', (req,res)=>{
        const userInfo = req.body;
        const token = jwt.sign(userInfo, process.env.SECRET_ACCESS_TOKEN, {
            expiresIn: '1h'
        })
        res.send({token})
    })
    //----------------- CRON JOB SHCEDULED TASK------------------
    //event status update to completed
    cron.schedule('0 * * * *', async () => { // Run every hour
        console.log('Running hourly cron job to update event statuses...');
        try {
            const now = new Date();
            // Get the current local time for comparison
            const localNow = new Date(now.getTime() - (now.getTimezoneOffset() * 60000));
            console.log(localNow);

            // Find all upcoming events that have started
            await eventCollection.updateMany(
                {
                    date: { $lt: localNow.toISOString() },
                    status: 'upcoming'
                },
                {
                    $set: { status: 'ongoing' }
                }
            );

            // Find all ongoing events that have ended
            const ongoingEvents = await eventCollection.find({ status: 'ongoing' }).toArray();
            
            for (const event of ongoingEvents) {
                const eventDate = new Date(event.date);
                const eventEndTime = new Date(eventDate.getTime() + event.duration * 60000); // duration is in minutes
                
                if (localNow >= eventEndTime) {
                    await eventCollection.updateOne(
                        { _id: event._id },
                        { $set: { status: 'completed' } }
                    );
                }
            }

            console.log('Finished updating event statuses.');
        } catch (error) {
            console.error('Error running hourly cron job:', error);
        }
    });

    //Cron job to handle volunteer warnings
    cron.schedule('0 1 * * *', async () => {
        console.log('Running nightly cron job to check for absent volunteers...');
        try {
            const completedEvents = await eventCollection.find({
                status: 'completed',
                $or: [{ checked: false }, { checked: { $exists: false } }]
            }).toArray();
            // console.log(completedEvents);

            for (const event of completedEvents) {
                for (const volunteer of event.volunteers) {
                    if (volunteer?.isPresent === false || volunteer?.isPresent === undefined) {
                        const user = await userCollection.findOne({ email: volunteer.email });
                        // console.log('user:',user);
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
                                // For a permanent ban, a very distant date can be used or a flag.
                                // For this example, we'll use a flag on the user document.
                                await userCollection.updateOne(
                                    { email: user.email },
                                    { $set: { isPermanentlyBanned: true } }
                                );
                            }
                            
                            // Update user's warning count and ban status
                            await userCollection.updateOne(
                                { email: user.email },
                                {
                                    $set: {
                                        warnings: newWarningCount,
                                        banUntil: banUntil
                                    }
                                }
                            );

                            // Add a notification for the user
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
                // Mark the event as checked so it's not processed again
                await eventCollection.updateOne(
                    { _id: event._id },
                    { $set: { checked: true } }
                );
            }
            console.log('Finished checking for absent volunteers.');
        } catch (error) {
            console.error('Error running volunteer check cron job:', error);
        }
    });
    //----------------- USER RELATED API---------------------
    app.get('/users', verifyToken, verifyAdmin, async(req,res)=>{
        const result = await userCollection.find().toArray();
        res.send(result);
    })
    // API to get a single user's data for their profile page
    app.get('/users/profile', verifyToken, async(req, res)=>{
        const email = req.decoded.email;
        const user = await userCollection.findOne({ email });
        if (!user) {
            return res.status(404).send({message: 'User not found'});
        }
        res.send(user);
    })
    //get user role----->
    app.get('/users/role/:email', async(req,res)=>{
        const query = { email : req.params.email };
        const user = await userCollection.findOne(query);
        const role = user?.role;
        res.send({role})
    })
    app.get('/users/pending-organizer-count', verifyToken, verifyAdmin, async(req,res)=>{
      const query = {role : 'pending-organizer'}
      const result = await userCollection.countDocuments(query);
      res.send(result);
    })
    app.post('/users', async(req,res)=>{
        const user = req.body;
        const query = { email : user?.email };
        const existingUser = await userCollection.findOne(query);
        if(existingUser){
            return res.send({message:'User already existed'})
        }
        const result = await userCollection.insertOne(user);
        //activity log
        if(result.acknowledged){
          const activity = {
            action: 'New user registered',
            userEmail: user?.email,
            target: {
                type: 'user',
                userId: result.insertedId,
                name: user?.name || 'Anonymous User'
            },
            timestamp: new Date()
          };
          await activityCollection.insertOne(activity);
        }
        res.send(result);
    })
    //update user profile
    app.patch('/users/:email', verifyToken, async (req, res) => {
      try {
        const { email } = req.params;
        const updateData = req.body;
        
        // Verify the user is updating their own profile or is an admin
        if (req.decoded.email !== email && req.decoded.role !== 'admin') {
          return res.status(403).json({ 
            success: false, 
            message: 'Access denied' 
          });
        }

        // Remove sensitive fields that shouldn't be updated this way
        delete updateData.email;
        delete updateData.role;
        delete updateData._id;

        // Add timestamp
        updateData.updatedAt = new Date();
        console.log(updateData);

        const result = await userCollection.updateOne(
          { email: email },
          { $set: updateData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ 
            success: false, 
            message: 'User not found' 
          });
        }

        res.json({ 
          success: true, 
          message: 'Profile updated successfully',
          modifiedCount: result.modifiedCount 
        });

      } catch (error) {
        console.error('Error updating user profile:', error);
        res.status(500).json({ 
          success: false, 
          message: 'Server error', 
          error: error.message 
        });
      }
    });
    //volunteer role change request
    app.patch('/users/roleRequest/:email',verifyToken, async(req, res)=>{
      const email = req.params.email;
      const {role : newRole} = req?.body;
      const user = await userCollection.findOne({email : email});
      if(!user){
        return res.status(404).send({message:'User not found'})
      }
      const result = await userCollection.updateOne(
        {email : email},
        {$set:{role:newRole}}
      )
      res.send(result);
    })
    //user role change----->
    app.patch('/users/role/:email',verifyToken, verifyAdmin, async(req,res)=>{
        const email = req.params.email;
        const adminEmail = req.decoded?.email;
        const {role : newRole}= req?.body;
        // console.log(id);
        // console.log(role);
        const query = { email : email};
        const user = await userCollection.findOne(query);
        if(!user){
          return res.status(404).send({message:'User not found'})
        }
        const previousRole = user?.role;
        let message ='';
        let type;

        if((newRole==='admin' && (previousRole==='volunteer' || previousRole==='organizer' || previousRole==='pending-organizer')) || (newRole==='organizer' && previousRole==='volunteer')){
          message=`Congratulations! You are an ${newRole} now`;
          type = 'success';
        }
        else if(newRole==='volunteer' && previousRole==='pending-organizer'){
          message="Your request for an organizer role was not approved. You remain a volunteer.";
          type = 'sorry';
        }
        else if(newRole==='volunteer' || newRole==='organizer' || newRole==='admin'){
          message=`Your role has been changed to ${newRole}`;
          type = 'neutral';
        }
        console.log(message);

        const updatedDoc={
            $set:{
              role:newRole
            }
        }
        const result = await userCollection.updateOne(query, updatedDoc);

        if(result.modifiedCount>0 && message){
          // console.log('inside condition',message);
          const notification = {
            email : email,
            message: message,
            type: type,
            read : false,
            toastShown: false,
            timestamp: new Date()
          }
          await notificationCollection.insertOne(notification);
        }
        if(result.acknowledged){
          const activity = {
            action: `Changed user role to ${newRole}`,
            userEmail: adminEmail, // The admin's email from decoded token
            target: {
                type: 'user',
                userId: user._id,
                name: user.name,
                previousRole: user.role,
                newRole: newRole
            },
            timestamp: new Date()
          };
          await activityCollection.insertOne(activity);
        }
        res.send(result);
    })

    // ----------------- NOTIFICATION RELATED API ---------------------
    //get notifications which hasn't shown toast
    app.get('/notifications/notToastShown/:email', async(req, res)=>{
      const email = req.params?.email;
      const query = { email : email, toastShown : false } 
      const result = await notificationCollection.find(query).toArray();
      res.send(result);
    })
    //get unread notifications
    app.get('/notifications/:email', async(req, res) => {
      const email = req.params?.email;
      const query = { email: email, read: false };
      const count = await notificationCollection.countDocuments(query);
      res.send({ count });
    });
    //get all notification for specific user
    app.get('/notifications/all/:email', verifyToken, async(req, res) => {
      const email = req.params?.email;
      const query = { email: email };
      const result = await notificationCollection.find(query)
        .sort({ timestamp: -1 })
        .toArray();
      res.send(result);
    });
    app.post('/notifications', async(req, res) => {
      const notificationData = {
        ...req.body,
        toastShown:false,
        read: false,
        timestamp: new Date()
      };
      const result = await notificationCollection.insertOne(notificationData);
      res.send(result);
    });
    //auto mark toast shown
    app.patch('/notifications/markToastShown/:email', async(req,res)=>{
      const email = req.params?.email;
      const query = { email : email, toastShown : false };
      const updatedDoc={
        $set:{
          toastShown:true
        }
      }
      const result = await notificationCollection.updateMany(query, updatedDoc);
      res.send(result);
    })
    //mark read update
    app.patch('/notifications/markAsRead/:id', async(req, res) => {
      const id = req.params?.id;
      const result = await notificationCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { read: true } }
      );
      res.send(result);
    });
    app.patch('/notifications/markAllAsRead/:email', async(req, res) => {
      const email = req.params?.email;
      const result = await notificationCollection.updateMany(
        { email: email, read: false },
        { $set: { read: true } }
      );
      res.send(result);
    });
    //delete notification
    app.delete('/notifications/:id', async(req, res) => {
      const id = req.params?.id;
      const result = await notificationCollection.deleteOne(
        { _id: new ObjectId(id) }
      );
      res.send(result);
    });

    // ----------------- EVENT RELATED API ---------------------
    //get all events
    app.get('/events', async(req, res)=>{
        const number = parseInt(req.query?.limit);
        const status = req.query?.status;
        const organizerEmail = req.query?.organizerEmail;
        const userEmail = req.query?.userEmail;
        // console.log(number,status,organizerEmail);
        let result;
        if(number && number>0){
            result = await eventCollection.find({status:'upcoming'}).project({ secretCode: 0 }).limit(number).toArray();
        }
        else if(status === 'upcoming'){
          result = await eventCollection.find({status:'upcoming'}).project({ secretCode: 0 }).toArray();
        }
        else if(status === 'completed'){
          result = await eventCollection.find({status:'completed'}).project({ secretCode: 0 }).toArray();
        }
        else if(status === 'cancelled'){
          result = await eventCollection.find({status:'cancelled'}).project({ secretCode: 0 }).toArray();
        }
        else if(organizerEmail){
          result = await eventCollection.find({organizerEmail:organizerEmail}).project({ secretCode: 0 }).toArray();
        }
        else if(userEmail){
          const query = { email : userEmail };
          const user = await userCollection.findOne(query);
          if (!user) {
            return res.status(404).send({ error: "User not found" });
          }
          const registeredEventIds = user.registeredEvents.map(id=>new ObjectId(id));
          result = await eventCollection.find({
            _id : { $in: registeredEventIds }
          }).project({secretCode:0}).toArray();
        }
        else{
            result = await eventCollection.find().project({ secretCode: 0 }).toArray();
        }
        res.send(result);
    })

    //get single event
    app.get('/events/:id', async(req,res)=>{
      const id = req.params.id;
      const query = { _id : new ObjectId(id) };
      const event = await eventCollection.findOne(query);
      const organizerEmail = event?.organizerEmail;
      const user = await userCollection.findOne({ email : organizerEmail }, { projection: {secretCode:0} });
      const organizerName = user?.name;
      const result ={...event, organizerName:organizerName}
      console.log(organizerName, result);
      res.send(result);
    })
    //check secret code
    app.post('/events/check-secret-code', async (req, res) => {
        const { secretCode } = req.body;
        const query = { secretCode: secretCode };
        const existingEvent = await eventCollection.findOne(query);
        if (existingEvent) {
            return res.send({ isAvailable: false });
        } else {
            return res.send({ isAvailable: true });
        } 
    });
    //add or post event
    app.post('/events', verifyToken, verifyOrganizer, async (req, res) => {
        const event = req.body;
        if(!event?.secretCode){
          let uniqueCodeFound = false;
          let generatedCode;

          while (!uniqueCodeFound) {
              generatedCode = generateSecretCode();
              const existingEvent = await eventCollection.findOne({ secretCode: generatedCode });
              
              if (!existingEvent) {
                  uniqueCodeFound = true;
              }
          }
          event.secretCode = generatedCode;
        }
        // console.log(event);
        const result = await eventCollection.insertOne(event);
        //activity log
        if (result.acknowledged) {
          const activity = {
              action: 'New event created',
              userEmail: req.decoded.email, // The organizer's email
              target: {
                  type: 'event',
                  eventId: result.insertedId,
                  title: event.title
              },
              timestamp: new Date()
          };
          await activityCollection.insertOne(activity);
        }
        res.send(result);
    });
    //update event
    app.patch('/events/:id', verifyToken, verifyOrganizer, async(req, res)=>{
      const id = req.params.id;
      const event = req.body;
      const query = { _id : new ObjectId(id) };
      const updatedDoc={
        $set:event
      }
      // console.log(event);
      const result = await eventCollection.updateOne(query, updatedDoc)
      res.send(result);
    })
    //view update
    app.patch('/events/views/:id', async(req, res)=>{
      const id = req.params.id;
      const event = { _id : new ObjectId(id) };
      const updatedDoc = {
        $inc:{
          views:1
        }
      }
      const result = await eventCollection.updateOne(event, updatedDoc);
      res.send(result);
    })
    //share update
    app.patch('/events/share/:id', async(req,res)=>{
      const id = req.params.id;
      const query = { _id : new ObjectId(id) };
      const updatedDoc={
        $inc:{
          share:1
        }
      }
      const result = await eventCollection.updateOne(query, updatedDoc);
      res.send(result);
    })
    //interested update
    app.patch('/events/interested/:id', async(req,res)=>{
      const id = req.params.id;
      const {userEmail} = req.body;
      const query = { _id : new ObjectId(id) };
      const updatedDoc = {
            $addToSet: {
                interestedUsers: userEmail
            },
            $inc: {
                interestedCount: 1
            }
        };
      const result = await eventCollection.updateOne(query, updatedDoc);
      res.send(result);
    })
    //make uninterested update
    app.patch('/events/uninterested/:id',async(req,res)=>{
      const id = req.params.id;
        const { userEmail } = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
            $pull: {
                interestedUsers: userEmail
            },
            $inc: {
                interestedCount: -1
            }
        };

        const result = await eventCollection.updateOne(query, updatedDoc);
        res.send(result);
    })
    //add volunteer update
    app.patch('/events/addVolunteer/:id', verifyToken, async(req, res)=>{
      const eventId = req.params.id;
      const {userEmail} = req.body;
      const user = await userCollection.findOne({email : userEmail});

       // Check for ban status
      if(user.banUntil && new Date(user.banUntil) > new Date()){
          const banEndDate = new Date(user.banUntil).toLocaleDateString();
          return res.status(409).send({
              message: `You are temporarily banned from registering for events until ${banEndDate}.`
          });
      }
      if(user.isPermanentlyBanned){
          return res.status(409).send({
              message: 'You have been permanently banned from registering for events due to repeated absences.'
          });
      }

      const filter = { _id : new ObjectId(eventId) };
      const updatedDoc={
        $addToSet:{
          volunteers: {
            name : user?.name,
            email : userEmail,
            registeredAt: new Date(),
            isPresent:false
          }
        }
      }
      const result = await eventCollection.updateOne(filter,updatedDoc);
      if(result.modifiedCount>0){
        await userCollection.updateOne({email : userEmail}, {$addToSet:{registeredEvents:eventId}})
        const event = await eventCollection.findOne({_id : new ObjectId(eventId)});
        const activity = {
          action: 'Volunteer registered for event',
          userEmail: user.email, // The volunteer's email
          target: {
              type: 'event',
              eventId: eventId,
              title: event?.title
          },
          timestamp: new Date()
        };
        await activityCollection.insertOne(activity);
      }
      res.send(result);
    })
    //remove volunteer update by organizer or admin
    app.patch('/events/removeVolunteer/:eventId', verifyToken, verifyOrganizer, async(req, res) => {
      const eventId = req.params.eventId;
      const { volunteerEmail } = req.body;
      try{
        const event = await eventCollection.findOne({_id: new ObjectId(eventId)});
        if (!event) {
          return res.status(404).send({message: 'Event not found'});
        }
  
        const eventUpdateResult = await eventCollection.updateOne(
          { _id: new ObjectId(eventId) },
          { $pull: { volunteers: { email: volunteerEmail } } }
        );
        const userUpdateResult = await userCollection.updateOne(
          { email : volunteerEmail },
          { $pull: { registeredEvents: eventId } }
        );
        if(eventUpdateResult.acknowledged && userUpdateResult.acknowledged){
          const volunteer = await userCollection.findOne({email: volunteerEmail});
          const activity = {
            action: 'Volunteer removed from event',
            userEmail: req.decoded.email, // The organizer's email
            target: {
                type: 'volunteer',
                volunteerName: volunteer.name,
                eventId: eventId,
                eventTitle: event.title
            },
            timestamp: new Date()
          };
          await activityCollection.insertOne(activity);
        }
        res.send({ modifiedCount: 1, message: 'Volunteer removed successfully.' });
      }catch(error){
        res.status(500).send({ message: 'Internal server error.' });
      }
      //if res.mofifiedCount>0 then send notification this system is done in the front end
    });

    //cancel registration from event update
    app.patch('/events/cancelRegistration/:eventId', verifyToken, async(req,res)=>{
      const eventId = req.params.eventId;
      const volunteerEmail = req.decoded.email;
      const event = await eventCollection.findOne({_id: new ObjectId(eventId)});
      if (!event) {
        return res.status(404).send({message: 'Event not found'});
      }
      const eventUpdateResult = await eventCollection.updateOne(
          { _id: new ObjectId(eventId) },
          { $pull: { volunteers: { email: volunteerEmail } } }
        );

      const userUpdateResult = await userCollection.updateOne(
          { email : volunteerEmail },
          { $pull: { registeredEvents : eventId } }
      );
      if (eventUpdateResult.modifiedCount > 0 && userUpdateResult.modifiedCount > 0) {
          // Send notification to the organizer
          const notification = {
              email: event.organizerEmail,
              message: 'Volunteer Canceled Registration',
              reason: `A volunteer with the email ${volunteerEmail} has canceled their registration for your event: "${event.title}".`,
              type: 'neutral',
              read: false,
              toastShown:false,
              timestamp: new Date()
          };
          await notificationCollection.insertOne(notification);
          res.send({ modifiedCount: 1, message: 'Registration cancelled successfully.' });
      }
    })

    //cancel event update
    app.patch('/events/cancel/:eventId', verifyToken, verifyOrganizer, async(req, res) => {
      const eventId = req.params.eventId;
      const { reason, cancelledBy, cancelledAt } = req.body;
      
      const result = await eventCollection.updateOne(
        { _id: new ObjectId(eventId) },
        { 
          $set: { 
            status: 'cancelled',
            cancellationReason: reason,
            cancelledBy: cancelledBy,
            cancelledAt: cancelledAt
          } 
        }
      );
      if(result.acknowledged){
        const event = await eventCollection.findOne({_id : new ObjectId(eventId)});
        const activity = {
          action: 'Event cancelled',
          userEmail: req.decoded.email, // The organizer's email
          target: {
              type: 'event',
              eventId: eventId,
              title: event.title,
              cancellationReason: reason
            },
            timestamp: new Date()
        };
        await activityCollection.insertOne(activity);
      }
      
      res.send(result);
    });
    //organizer attendence to volunteer update
    app.patch('/events/:eventId/volunteers/:volunteerEmail/attendance', verifyToken, verifyOrganizer, async (req, res) => {
      try {
        const { eventId, volunteerEmail } = req.params;
        const {isPresent} = req.body;
        console.log(isPresent);
        const event = await eventCollection.findOne({ _id: new ObjectId(eventId) });
        
        if (!event) {
          return res.status(404).json({ success: false, message: 'Event not found' });
        }
        
        // Check if volunteer is registered for this event
        const isRegistered = event.volunteers.some(v => v.email === volunteerEmail);
        if (!isRegistered) {
          return res.status(400).json({ success: false, message: 'Volunteer not registered for this event' });
        }
        
        const result = await eventCollection.updateOne(
            { 
                _id: new ObjectId(eventId),
                'volunteers.email': volunteerEmail 
            },
            {
                $set: { 'volunteers.$.isPresent': isPresent }
            }
        );
        res.send(result);
        
      } catch (error) {
        console.error('Error updating attendance:', error);
        res.status(500).json({ success: false, message: 'Server error', error: error.message });
      }
    });
    //volunteer self attendance update
    app.patch('/events/:eventId/mark-self-attendance', verifyToken, async (req, res) => {
      try {
        const { eventId } = req.params;
        const { secretCode } = req.body;
        const volunteerEmail = req.decoded.email; // Get from token
        console.log(secretCode,volunteerEmail);

        const event = await eventCollection.findOne({ _id: new ObjectId(eventId) });
        
        if (!event) {
          return res.status(404).json({ success: false, message: 'Event not found' });
        }

        // Check if volunteer is registered
        const volunteer = event.volunteers.find(v => v.email === volunteerEmail);
        if (!volunteer) {
          return res.status(400).json({ success: false, message: 'Not registered for this event' });
        }

        // Verify secret code
        if (event.secretCode !== secretCode) {
          return res.status(400).json({ success: false, message: 'Invalid secret code' });
        }

        // Update the volunteer's isPresent status in the volunteers array
        const result = await eventCollection.updateOne(
          { 
            _id: new ObjectId(eventId),
            'volunteers.email': volunteerEmail 
          },
          {
            $set: { 
              'volunteers.$.isPresent': true,
            }
          }
        );

        res.send(result);

      } catch (error) {
        console.error('Error marking self-attendance:', error);
        res.status(500).json({ success: false, message: 'Server error' });
      }
    });

    // ----------------- COMMENT RELATED API ---------------------
    app.get('/comments/count/:id', async(req, res)=>{
      const eventId = req.params.id;
      const query = { eventId : eventId };
      const result = await commentCollection.countDocuments(query);
      res.send(result);
    })
    app.get('/comments/:id', async(req,res)=>{
      const eventId = req.params.id;
      const query = { eventId : eventId };
      const result = await commentCollection.find(query).sort({ timestamp: -1 }).toArray();
      res.send(result);
    })
    //add comment
    app.post('/comments', verifyToken, async(req, res)=>{
      const comment = req.body;
      const result = await commentCollection.insertOne(comment);
      if(result.acknowledged){
        const activity = {
          action: 'New comment added',
          userEmail: req.decoded.email,
          target: {
              type: 'comment',
              commentId: result.insertedId,
              eventId: comment.eventId,
              text: comment.text,
              userName:comment.user_name
          },
          timestamp: new Date()
        };
        await activityCollection.insertOne(activity);
      }
      res.send(result);
    })
    app.delete(`/comments/:id`, verifyToken, async(req,res)=>{
      const id = req.params.id;
      const query = { _id : new ObjectId(id) };
      const result = await commentCollection.deleteOne(query);
      res.send(result);
    })

    // ----------------- REVIEW RELATED API ---------------------
    app.get('/reviews', async(req,res)=>{
        const query = { approved : true }
        const result = await reviewCollection.find(query).toArray();
        res.send(result)
      })
    //get user specific review
    app.get('/reviews/:email', verifyToken, async(req,res)=>{
      const email = req.params.email;
      const result = await reviewCollection.find({reviewerEmail : email}).toArray();
      res.send(result);
    })
    app.post('/reviews', verifyToken, async(req,res)=>{
      const reviewData = req.body;
      const result = await reviewCollection.insertOne(reviewData);
      res.send(result);
    })

    // ----------------- ACTIVITY RELATED API ---------------------
    app.get('/activities', async (req, res) => {
    const limit = 3; 
    const activityTypes = ['user', 'event', 'volunteer', 'comment'];

    let activities = [];
    for (const type of activityTypes) {
        const result = await activityCollection
            .find({ 'target.type': type })
            .sort({ timestamp: -1 })
            .limit(limit)
            .toArray();
        activities.push(...result);
    }
    activities.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const finalActivities = activities.slice(0, 4);

    res.send(finalActivities);
});


    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);



app.get('/', (req,res)=>{
    res.send('Event up running properly');
})

app.listen(port, ()=>{
    console.log(`EventUp is running on port ${port}`);
})