require("dotenv").config();
const connectDB = require("./database/conn");

if (!process.env.JWT_SECRET) {
  console.error("JWT_SECRET is not set");
  process.exit(1);
}

const app = require("./app");
connectDB();

app.listen(4000, () => console.log("Example app is listening on port 4000."));
