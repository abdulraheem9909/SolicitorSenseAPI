const mongoose = require("mongoose");

const connect = () => mongoose.connect(process.env.MONGO_TEST_URI);

const clear = async () => {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
};

const close = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
};

module.exports = { connect, clear, close };
