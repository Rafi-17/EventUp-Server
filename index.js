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
    // await client.connect();

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
            // console.log(localNow);

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
                    console.log('event updated to completed');
                }
            }

            console.log('Finished updating event statuses.');
        } catch (error) {
            console.error('Error running hourly cron job:', error);
        }
    });

    // //Cron job to handle volunteer warnings
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
    //check ongoing events of user
    app.get('/users/ongoing-events-status', verifyToken, async (req, res) => {
            try {
                const { email } = req.decoded;
                console.log(email);
                const user = await userCollection.findOne({ email });

                if (!user) {
                    return res.status(404).json({ error: 'User not found' });
                }

                const isOngoing = {
                    organizedEvent: false,
                    registeredEvent: false
                };

                if (user.role === 'admin' || user.role === 'organizer') {
                    // Check for ongoing events created by the organizer/admin
                    const ongoingOrganizerEvent = await eventCollection.findOne({
                        organizerEmail: email,
                        status: 'ongoing'
                    });

                    if (ongoingOrganizerEvent) {
                        isOngoing.organizedEvent = true;
                    }
                }

                // Check for ongoing events the user has registered for (for all user roles)
                const registeredEventIds = user.registeredEvents || [];
                // Convert the string IDs to ObjectId objects for the MongoDB query
                const registeredObjectIds = registeredEventIds.map(id => new ObjectId(id));
                
                // Check for ongoing events the user has registered for
                const ongoingRegisteredEvent = await eventCollection.findOne({
                    _id: { $in: registeredObjectIds },
                    status: 'ongoing'
                });

                if (ongoingRegisteredEvent) {
                    isOngoing.registeredEvent = true;
                }

                res.json({ isOngoing });

            } catch (error) {
                console.error('Error in ongoing-events-status API:', error);
                res.status(500).json({ error: 'Internal server error' });
            }
        });
    //add user
    app.post('/users', async(req,res)=>{
        const user = req.body;
        const query = { email : user?.email };
        const existingUser = await userCollection.findOne(query);
        if(existingUser){
            return res.send({message:'User already existed'})
        }
        user.createdAt = new Date();
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
        // console.log(updateData);

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
        {$set:{role:newRole, reqTime: new Date()}}
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

        if((newRole==='admin' && (previousRole==='volunteer' || previousRole==='organizer' || previousRole==='pending-organizer')) || (newRole==='organizer' && (previousRole==='volunteer' || previousRole==='pending-organizer'))){
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
        // console.log(message);

        const updatedDoc={
            $set:{
              role:newRole,
              reqTime: ''
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
      const { count, limit, status, organizerEmail, userEmail, category, search, key } = req.query;
      
      // Start with an empty query object
      const query = {};
      // console.log(status);
      // Add filters conditionally
      if (status) {
        // If status is a string containing a comma, split it into an array
        if (typeof status === 'string' && status.includes(',')) {
            query.status = { $in: status.split(',') };
        } else if (status !== 'all') {
            query.status = status;
        }
    }
      if (organizerEmail) {
          query.organizerEmail = organizerEmail;
      }

      if (userEmail) {
          const user = await userCollection.findOne({ email: userEmail });
          if (!user) {
              return res.status(404).send({ error: "User not found" });
          }
          const registeredEventIds = user.registeredEvents.map(id => new ObjectId(id));
          query._id = { $in: registeredEventIds };
      }

      if (count) {
          const totalCount = await eventCollection.countDocuments(query);
          return res.send({ count: totalCount });
      }

      if (category && category !== 'all') {
          query.category = category;
      }

      // Handle the search term using a regex for case-insensitive search
      if (search) {
          const searchRegex = new RegExp(search, 'i');
          query.$or = [
              { title: { $regex: searchRegex } },
              { description: { $regex: searchRegex } },
              { location: { $regex: searchRegex } }
          ];
      }
      
      const options = {
          sort: { _id: -1 }
      };
      if (key !== 'true') {
        options.projection = { secretCode: 0 };
    } 
      // console.log(options);

      if (limit && limit > 0) {
          options.limit = parseInt(limit);
      }
      
      const result = await eventCollection.find(query, options).toArray();
      // console.log(result);
      res.send(result);
  })
    //was using-------------->
    // app.get('/events', async(req, res)=>{
    //     const number = parseInt(req.query?.limit);
    //     const status = req.query?.status;
    //     const organizerEmail = req.query?.organizerEmail;
    //     const userEmail = req.query?.userEmail;
    //     // console.log(number,status,organizerEmail);
    //     let result;
    //     if(number && number>0){
    //         result = await eventCollection.find({status:'upcoming'}).project({ secretCode: 0 }).limit(number).toArray();
    //     }
    //     else if(status === 'upcoming'){
    //       result = await eventCollection.find({status:'upcoming'}).sort({ _id: -1 }).project({ secretCode: 0 }).toArray();
    //     }
    //     else if(status === 'completed'){
    //       result = await eventCollection.find({status:'completed'}).sort({ _id: -1 }).project({ secretCode: 0 }).toArray();
    //     }
    //     else if(status === 'cancelled'){
    //       result = await eventCollection.find({status:'cancelled'}).sort({ _id: -1 }).project({ secretCode: 0 }).toArray();
    //     }
    //     else if(organizerEmail){
    //       result = await eventCollection.find({organizerEmail:organizerEmail}).project({ secretCode: 0 }).toArray();
    //     }
    //     else if(userEmail){
    //       const query = { email : userEmail };
    //       const user = await userCollection.findOne(query);
    //       if (!user) {
    //         return res.status(404).send({ error: "User not found" });
    //       }
    //       const registeredEventIds = user.registeredEvents.map(id=>new ObjectId(id));
    //       result = await eventCollection.find({
    //         _id : { $in: registeredEventIds }
    //       }).project({secretCode:0}).toArray();
    //     }
    //     else{
    //         result = await eventCollection.find().sort({ _id: -1 }).project({ secretCode: 0 }).toArray();
    //     }
    //     res.send(result);
    // })

    //get single event
    app.get('/events/:id', async(req,res)=>{
      const id = req.params.id;
      const query = { _id : new ObjectId(id) };
      const event = await eventCollection.findOne(query);
      const organizerEmail = event?.organizerEmail;
      const user = await userCollection.findOne({ email : organizerEmail }, { projection: {secretCode:0} });
      const organizerName = user?.name;
      const result ={...event, organizerName:organizerName}
      // console.log(organizerName, result);
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
      const event = await eventCollection.findOne({_id : new ObjectId(eventId)});
      if(result.modifiedCount>0){
        // add the eventId to the user db collection
        await userCollection.updateOne({email : userEmail}, {$addToSet:{registeredEvents:eventId}})
        // adding this as a activity of the website for admin
        const activity = {
          action: 'Volunteer registered for event',
          userEmail: user.email,
          target: {
              type: 'event',
              eventId: eventId,
              title: event?.title
          },
          timestamp: new Date()
        };
        await activityCollection.insertOne(activity);
        // send notifiation to the organizer
        const notification = {
            email: event?.organizerEmail,
            message: 'New Volunteer Registered',
            eventTitle: event?.title,
            reason: `A new volunteer named ${user?.name} has registered for your event: "${event?.title}".`,
            type: 'success',
            read: false,
            toastShown: false,
            timestamp: new Date()
        };
        await notificationCollection.insertOne(notification);
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
              message: 'Volunteer Cancelled Registration',
              eventTitle: event?.title,
              reason: `A volunteer with the email ${volunteerEmail} has cancelled their registration for your event: "${event.title}".`,
              type: 'sorry',
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
        // console.log(isPresent);
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
        // console.log(secretCode,volunteerEmail);

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
    //get event specific review
    app.get('/reviews/:eventId', verifyToken, async(req,res)=>{
        const { eventId } = req.params;
        const { status } = req.query;

        const query={};
        
        if (status && status === 'approved') {
            query.approved = true;
        } else {
            query.eventId = eventId;
        }

        try {
            const result = await reviewCollection.find(query).toArray();
            res.send(result);
        } catch (error) {
            console.error('Error fetching reviews:', error);
            res.status(500).send({ message: 'An internal server error occurred.' });
        }
    })
    // post review
    app.post('/reviews', verifyToken, async(req,res)=>{
      const reviewData = req.body;
      const result = await reviewCollection.insertOne(reviewData);
      console.log(result);
      if(result.acknowledged){
        const event = await eventCollection.findOne({_id : new ObjectId(reviewData?.eventId)})
        console.log(event);
        if(event){
          const notification = {
                email: event?.organizerEmail,
                message: 'New Event Review Received',
                eventTitle: event?.title,
                reason: `A volunteer named ${reviewData?.reviewerName} has reviewed your event "${event.title}".`,
                type: 'neutral',
                read: false,
                toastShown:false,
                timestamp: new Date()
            };
            await notificationCollection.insertOne(notification);
        }
      }
      res.send(result);
    })
    //change approve status of review
    app.patch('/reviews/:reviewId/status', verifyToken, async(req,res)=>{
        const reviewId = req.params.reviewId;
        const { approved } = req.body;
        
        // Validate the input
        if (!reviewId || typeof approved !== 'boolean') {
            return res.status(400).send({ message: 'Invalid request data. Requires review ID and a boolean for approval status.' });
        }

        try {
            const result = await reviewCollection.updateOne(
                { _id: new ObjectId(reviewId) },
                { $set: { approved: approved } }
            );
            res.send(result);
        } catch (error) {
            console.error('Error updating review approval status:', error);
            res.status(500).send({ message: 'An internal server error occurred.' });
        }
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

    // ----------------- ADMIN STAT API ---------------------   
    app.get('/admin-stats', async(req, res) => {
      try {
        // Total users excluding admin
        const userResult = await userCollection.aggregate([
          {
            $match: {
              role: { $ne: 'admin' }
            }
          },
          {
            $count: "totalUsers"
          }
        ]).toArray();
        const totalUsers = userResult.length > 0 ? userResult[0].totalUsers : 0;

        // Total events
        const totalEvents = await eventCollection.estimatedDocumentCount();

        // Pending organizer requests
        const pendingRequests = await userCollection.countDocuments({
          role: 'pending-organizer'
        });

        // Active organizers
        const activeOrganizers = await userCollection.countDocuments({
          role: 'organizer'
        });

        // Recent activity from activity collection
        const recentActivity = await activityCollection
          .find()
          .sort({ timestamp: -1 })
          .limit(8)
          .toArray();

        // Recent users (last 7 days)
        const recentUsers = await userCollection
          .find({
            role: { $ne: 'admin' },
            createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
          })
          .sort({ createdAt: -1 })
          .limit(5)
          .toArray();


        res.send({
          totalUsers,
          totalEvents,
          pendingRequests,
          activeOrganizers,
          recentActivity,
          recentUsers
        });
      } catch (error) {
        res.status(500).send({ error: error.message });
      }
    });

    // ----------------- ORGANIZER STAT API ---------------------   
    app.get('/organizer-stats/:email', verifyToken, async(req, res) => {
      try {
        const { email } = req.params;

        // My events summary
        const eventStats = await eventCollection.aggregate([
          { $match: { organizerEmail: email } },
          {
            $group: {
              _id: '$status',
              count: { $sum: 1 }
            }
          }
        ]).toArray();

        const upcomingEvents = eventStats.find(stat => stat._id === 'upcoming')?.count || 0;
        const completedEvents = eventStats.find(stat => stat._id === 'completed')?.count || 0;
        const cancelledEvents = eventStats.find(stat => stat._id === 'cancelled')?.count || 0;

        // Recent volunteer activity on my events
        const recentActivity = await eventCollection.aggregate([
          { $match: { organizerEmail: email } },
          { $unwind: '$volunteers' },
          { $sort: { 'volunteers.registeredAt': -1 } },
          { $limit: 10 },
          {
            $project: {
              eventTitle: '$title',
              volunteerName: '$volunteers.name',
              volunteerEmail: '$volunteers.email',
              registeredAt: '$volunteers.registeredAt'
            }
          }
        ]).toArray();

        // Upcoming deadlines (my upcoming events)
        const upcomingDeadlines = await eventCollection.find({
          organizerEmail: email,
          status: 'upcoming',
          date: { $gte: new Date().toISOString() }
        })
        .sort({ date: 1 })
        .limit(5)
        .project({ title: 1, date: 1, location: 1, volunteers: 1, requiredVolunteers: 1 })
        .toArray();

        // My volunteer activity (events I registered for)
        const myVolunteerEvents = await eventCollection.aggregate([
          { $match: { 'volunteers.email': email } },
          { $count: 'registeredEvents' }
        ]).toArray();

        const registeredEventsCount = myVolunteerEvents.length > 0 ? myVolunteerEvents[0].registeredEvents : 0;

        res.json({
          eventStats: {
            upcoming: upcomingEvents,
            completed: completedEvents,
            cancelled: cancelledEvents
          },
          recentActivity,
          upcomingDeadlines,
          registeredEventsCount
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // ------------------VOLUNTEER STAT API--------------------
    app.get('/stat/:email',async(req,res)=>{
      const email = req.params.email;
      const user = await userCollection.findOne({ email }, { projection: { interests: 1 } });
        const userInterests = user?.interests || [];

        // Recommended events based on interests
        let recommendedEvents;
        let recommendationMessage = '';

        if (userInterests.length > 0) {
          const interestsLowerCase = userInterests.map(interest => interest.toLowerCase());
          // console.log(interestsLowerCase);
          
          recommendedEvents = await eventCollection.find({
            status: 'upcoming',
            date: { $gte: new Date().toISOString() },
            'volunteers.email': { $ne: email }, // Not already registered
            category: { 
              $in: interestsLowerCase.map(interest => new RegExp(interest, 'i'))
            }
          })
          .sort({ date: 1 })
          .limit(6)
          .project({ title: 1, date: 1, location: 1, category: 1, organizerName: 1, volunteers: 1, requiredVolunteers: 1 })
          .toArray();
        } else {
          // Show recent upcoming events with a message
          recommendedEvents = await eventCollection.find({
            status: 'upcoming',
            date: { $gte: new Date() },
            'volunteers.email': { $ne: email }
          })
          .sort({ createdAt: -1 })
          .limit(6)
          .project({ title: 1, date: 1, location: 1, category: 1, organizerName: 1, volunteers: 1, requiredVolunteers: 1 })
          .toArray();

          recommendationMessage = 'Help us find events for you! Add your interests to get personalized recommendations.';
        }
        res.send(recommendedEvents)
    })

    //real api
    app.get('/volunteer-stats/:email', verifyToken, async(req, res) => {
      try {
        const { email } = req.params;

        // My upcoming events
        const upcomingEvents = await eventCollection.find({
          'volunteers.email': email,
          status: 'upcoming',
          date: { $gte: new Date().toISOString() }
        })
        .sort({ date: 1 })
        .limit(5)
        .project({ title: 1, date: 1, location: 1, organizerName: 1, _id: 1 })
        .toArray();

        // My volunteer impact - including missed events
        const impactStats = await eventCollection.aggregate([
          { $match: { 'volunteers.email': email } },
          { $unwind: "$volunteers" },
          { $match: { "volunteers.email": email }},
          {
            $facet: {
              totalEvents: [{ $count: "count" }],
              presentEvents: [
                { $match: { "volunteers.isPresent": true }},
                { $count: "count" }
              ],
              missedEvents: [
                { 
                  $match: { 
                    "status": "completed",
                    $or: [
                      { "volunteers.isPresent": { $exists: false } },
                      { "volunteers.isPresent": false }
                    ]
                  }
                },
                { $count: "count" }
              ],
              totalHours: [
                { 
                  $match: { 
                    "volunteers.isPresent": true,
                    "status": "completed"
                  }
                },
                {
                  $group: {
                    _id: null,
                    hours: { $sum: { $divide: ['$duration', 60] }}
                  }
                }
              ]
            }
          }
        ]).toArray();

        const stats = impactStats[0];
        const impact = {
          totalEvents: stats.totalEvents[0]?.count || 0,
          completedEvents: stats.presentEvents[0]?.count || 0,
          missedEvents: stats.missedEvents[0]?.count || 0,
          totalHours: Math.round(stats.totalHours[0]?.hours || 0)
        };

        // Get user interests
        const user = await userCollection.findOne({ email }, { projection: { interests: 1 } });
        const userInterests = user?.interests || [];

        // Recommended events logic
        let recommendedEvents = [];
        let recommendationMessage = '';
        const RECOMMENDATION_LIMIT = 3; // Adjust based on your frontend grid (4, 5, or 6)

        if (userInterests.length > 0) {
          // Try to find events matching user interests
          const interestsRegex = userInterests.map(interest => new RegExp(interest, 'i'));
          
          const matchingEvents = await eventCollection.find({
            status: 'upcoming',
            date: { $gte: new Date().toISOString() },
            'volunteers.email': { $ne: email },
            category: { $in: interestsRegex }
          })
          .sort({ date: 1 })
          .limit(RECOMMENDATION_LIMIT)
          .project({ 
            title: 1, date: 1, location: 1, category: 1, 
            organizerName: 1, volunteers: 1, requiredVolunteers: 1, _id: 1,
            interested: { $ifNull: ['$interested', 0] }
          })
          .toArray();

          if (matchingEvents.length === 0) {
            // No matching events found, show popular events
            recommendedEvents = await eventCollection.find({
              status: 'upcoming',
              date: { $gte: new Date().toISOString() },
              'volunteers.email': { $ne: email }
            })
            .sort({ interested: -1, createdAt: -1 })
            .limit(RECOMMENDATION_LIMIT)
            .project({ 
              title: 1, date: 1, location: 1, category: 1, 
              organizerName: 1, volunteers: 1, requiredVolunteers: 1, _id: 1,
              interested: { $ifNull: ['$interested', 0] }
            })
            .toArray();

            recommendationMessage = "We couldn't find any upcoming events that match your interests right now. In the meantime, check out what's popular!";
          } else if (matchingEvents.length < RECOMMENDATION_LIMIT) {
            // Found some matching events but need to fill remaining slots with popular events
            const remainingSlots = RECOMMENDATION_LIMIT - matchingEvents.length;
            const matchingEventIds = matchingEvents.map(event => event._id);
            
            const popularEvents = await eventCollection.find({
              status: 'upcoming',
              date: { $gte: new Date().toISOString() },
              'volunteers.email': { $ne: email },
              _id: { $nin: matchingEventIds } // Exclude already selected events
            })
            .sort({ interested: -1, createdAt: -1 })
            .limit(remainingSlots)
            .project({ 
              title: 1, date: 1, location: 1, category: 1, 
              organizerName: 1, volunteers: 1, requiredVolunteers: 1, _id: 1,
              interested: { $ifNull: ['$interested', 0] }
            })
            .toArray();

            recommendedEvents = [...matchingEvents, ...popularEvents];
            recommendationMessage = matchingEvents.length === 1 
              ? "We found 1 event matching your interests, plus some popular events you might like!"
              : `We found ${matchingEvents.length} events matching your interests, plus some popular events you might like!`;
          } else {
            // Found enough matching events
            recommendedEvents = matchingEvents;
          }
        } else {
          // No interests selected, show popular events
          recommendedEvents = await eventCollection.find({
            status: 'upcoming',
            date: { $gte: new Date().toISOString() },
            'volunteers.email': { $ne: email }
          })
          .sort({ interested: -1, createdAt: -1 })
          .limit(RECOMMENDATION_LIMIT)
          .project({ 
            title: 1, date: 1, location: 1, category: 1, 
            organizerName: 1, volunteers: 1, requiredVolunteers: 1, _id: 1,
            interested: { $ifNull: ['$interested', 0] }
          })
          .toArray();

          recommendationMessage = 'Help us find events for you! Add your interests to get personalized recommendations.';
        }

        // Recent community reviews
        const recentReviews = await reviewCollection.find({
          approved: true
        })
        .sort({ date: -1 })
        .limit(5)
        .project({ eventTitle: 1, rating: 1, quote: 1, reviewerName: 1, date: 1, reviewerRole: 1 })
        .toArray();

        res.json({
          upcomingEvents,
          impact,
          recommendedEvents,
          recommendationMessage,
          recentReviews
        });

      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });


    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
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