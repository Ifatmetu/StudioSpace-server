import express from "express";
import cors from "cors";
import "dotenv/config";
import dns from "node:dns";
import { MongoClient } from "mongodb";

// Fix for querySrv ECONNREFUSED issue with mongodb+srv on some ISPs/DNS
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const port = process.env.PORT || 5000;

const app = express();
app.use(cors());
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);

export async function connectToMongoDB() {
  try {
    await client.connect();
    // Verify connection by pinging
    await client.db("admin").command({ ping: 1 });
    console.log("Successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
  }
}

// Connect to MongoDB
const connectClient = await connectToMongoDB();
const db = client.db("stdiospace");
const studiosCollection = db.collection("studios");

app.get("/studios", async (req, res) => {
  try {
    const result = await studiosCollection.find({}).toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching studios:", error);
    res.status(500).json({ message: "Failed to fetch studios", error: error.message });
  }
});

app.post("/studios", async (req, res) => {
  try {
    const studio = req.body;
    const result = await studiosCollection.insertOne({
      ...studio,
      createdAt: new Date(),
    });
    res.status(201).send(result);
  } catch (error) {
    console.error("Error creating studio:", error);
    res.status(500).json({ message: "Failed to add studio", error: error.message });
  }
});

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/test", (req, res) => {
  res.json({ message: "test" });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
