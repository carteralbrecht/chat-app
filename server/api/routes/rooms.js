const express = require('express');
const router = express.Router();
const Room = require('../../models/Room');
const {v4: uuidv4} = require('uuid');
const oktaClient = require('../lib/oktaClient');
const authenticateUser = require('../authMiddleware');

/*
    - Gets all rooms a user is added to
    - Pulls from user authenticaion claims
*/
router.get('/', authenticateUser, async (req, res) => {
  const roomsAdded = res.locals.claims.roomsAdded;

  let rooms;
  try {
    rooms = await Room.find().where('_id').in(roomsAdded).exec();
  } catch (err) {
    console.log(err);
    return res.status(500).send(err);
  }

  return res.status(200).send({rooms});
});

/*
    - returns all rooms with queried tags
    https://stackoverflow.com/questions/44374267/mongoose-return-document-if-a-search-string-is-in-an-array
*/
router.post('/tags', authenticateUser, async (req, res) => {
  if (!req.body) {
    return res.sendStatus(400);
  }

  const tagsLookingFor = arrayToLower(req.body.tags);
  const conditions = {tags: {$in: tagsLookingFor}};

  Room.find(conditions).exec((err, rooms) => {
    if (err) {
      return res.status(500).send(err);
    } else {
      return res.status(200).send(rooms);
    }
  });
});

/*
    - Creates a room
    - Called by user
*/
router.post('/create', authenticateUser, async (req, res) => {
  if (!req.body) return res.sendStatus(400);

  const name = req.body.name;
  const email = req.body.email;
  const private = req.body.private;
  const tags = req.body.tags;

  let user;
  try {
    user = await oktaClient.getUser(email);
  } catch (err) {
    return res.status(500).send(err);
  }

  const ownerId = user.id;

  const roomToCreate = new Room({
    name,
    ownerId,
    private,
    joinCode: uuidv4(),
    users: [],
    messages: [],
    tags: arrayToLower(tags),
  });

  roomToCreate.users.push({
    userId: user.id,
    active: false,
  });

  let data;
  try {
    data = await roomToCreate.save();
  } catch (err) {
    return res.status(500).send(err);
  }

  const roomId = data._id;

  // Adds authentication claims to user
  if (!user.profile.roomsOwned) user.profile.roomsOwned = [];
  if (!user.profile.roomsAdded) user.profile.roomsAdded = [];

  user.profile.roomsOwned.push(roomId);
  user.profile.roomsAdded.push(roomId);

  await user.update();

  return res.status(200).send(data);
});

/*
    - Gets room join code
    - Called by room owner
*/
router.get('/code/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const roomsOwned = res.locals.claims.roomsOwned;

  // Check user claims before executing transaction
  if (!roomsOwned || !roomsOwned.includes(roomId)) return res.sendStatus(403);
  let room;
  try {
    room = await Room.findById(roomId);
  } catch (err) {
    return res.status(500).send(err);
  }

  return res.status(200).json({joinCode: room.joinCode});
});

/*
    - Resets room join code and returns it
    - Called by room owner
*/
router.post('/code/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const roomsOwned = res.locals.claims.roomsOwned;

  // Check user claims before executing transaction
  if (!roomsOwned || !roomsOwned.includes(roomId)) return res.sendStatus(403);

  const conditions = {_id: roomId};
  const update = {$set: {'joinCode': uuidv4()}};

  let room;
  try {
    room = await Room.findOneAndUpdate(conditions, update, {new: true});
  } catch (err) {
    return res.status(500).send(err);
  }

  return res.status(200).json({joinCode: room.joinCode});
});

/*
    - Delete room
    - Called by room owner
*/
router.delete('/delete/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const roomsOwned = res.locals.claims.roomsOwned;

  // Check user claims before executing transaction
  if (!roomsOwned || !roomsOwned.includes(roomId)) return res.sendStatus(403);

  try {
    await Room.deleteOne({_id: roomId});
  } catch (err) {
    return res.sendStatus(404);
  }

  return res.sendStatus(204);
});

/*
    - Leaves a user from room
    - Sets active field to false
    - Called by user
*/
router.post('/leave/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const claims = res.locals.claims;
  const userId = claims.userId;
  const roomsAdded = claims.roomsAdded;

  // Check user claims before executing transaction
  if (!roomsAdded || !roomsAdded.includes(roomId)) return res.sendStatus(403);

  const conditions = {
    '_id': roomId,
    'users.userId': userId,
  };

  const update = {$set: {'users.$.active': false}};

  let room;
  try {
    room = await Room.findOneAndUpdate(conditions, update, {new: true});
  } catch (err) {
    return res.status(500).send(err);
  }

  return res.status(200).send(room);
});

/*
    - Joins a user to room
    - Sets active field to true
    - Called by user
*/
router.post('/join/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const claims = res.locals.claims;
  const userId = claims.userId;
  const roomsAdded = claims.roomsAdded;

  // Check user claims before executing transaction
  if (!roomsAdded || !roomsAdded.includes(roomId)) return res.sendStatus(403);

  const conditions = {
    '_id': roomId,
    'users.userId': userId,
  };

  const update = {$set: {'users.$.active': true}};

  let room;
  try {
    room = await Room.findOneAndUpdate(conditions, update, {new: true});
  } catch (err) {
    res.status(500).send(err);
  }

  return res.status(200).send(room);
});

/*
    - Adds user to room
    - Called by user
*/
router.post('/add/:roomId', authenticateUser, async (req, res) => {
  if (!req.body) return res.sendStatus(400);

  const roomId = req.params.roomId;
  const claims = res.locals.claims;
  const userId = claims.userId;
  const joinCode = req.body.joinCode;

  const conditions = {
    '_id': roomId,
    joinCode,
    'users.userId': {$ne: userId},
  };

  const update = {
    $addToSet: {users: {userId, active: false}},
  };

  let room;
  try {
    room = await Room.findOneAndUpdate(conditions, update, {new: true});
  } catch (err) {
    return res.status(500).send(err);
  }

  // Removes roomsAdded claim from user
  let user;
  try {
    user = await oktaClient.getUser(userId);
  } catch (err) {
    return res.status(500).send(err);
  }

  if (!user.profile.roomsAdded) user.profile.roomsAdded = [];

  user.profile.roomsAdded.push(roomId);
  await user.update();

  return res.status(200).send(room);
});

/*
    - Removes user from room
    - Called by room owner
*/
router.post('/remove/:roomId', authenticateUser, async (req, res) => {
  const roomId = req.params.roomId;
  const claims = res.locals.claims;
  const userId = claims.userId;
  const roomsOwned = claims.roomsOwned;

  // Check user claims before executing transaction
  if (!roomsOwned || !roomsOwned.includes(roomId)) return res.sendStatus(403);

  const conditions = {
    '_id': roomId,
    'users.userId': userId,
  };

  const update = {
    $pull: {users: {userId}},
  };

  let room;
  try {
    room = await Room.findOneAndUpdate(conditions, update, {new: true});
  } catch (err) {
    return res.status(500).send(err);
  }

  // Removes roomsAdded claim from user
  let user;
  try {
    user = await oktaClient.getUser(userId);
  } catch (err) {
    return res.status(500).send(err);
  }

  delete user.profile.roomsAdded[roomId];
  await user.update();

  return res.status(200).send(room);
});

arrayToLower = (array) => {
  const arrayLower = [];
  for (let i = 0; i < array.length; i++) {
    arrayLower.push(array[i].toLowerCase());
  }
  return arrayLower;
};

module.exports = router;
