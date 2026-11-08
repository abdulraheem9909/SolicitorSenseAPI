const path = require("path");
const express = require("express");
const cors = require("cors");
const parseXML = require("./routes/lawData.routes");
const authRoutes = require("./routes/auth.routes");
const messageRoutes = require("./routes/chat.routes");
const requireAdminKey = require("./middlewares/requireAdminKey");

const app = express();
app.use(express.json());
app.use(cors());

// Serve the static Next.js export copied into ./public by the frontend's deploy.sh
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.send("Successful response.");
});
app.use("/api/parseXML", requireAdminKey, parseXML);
app.use('/api/auth', authRoutes);
app.use("/api/chat", messageRoutes)

// Return JSON instead of Express's default HTML page (which includes a stack trace)
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
});

module.exports = app;
