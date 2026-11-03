
import "dotenv/config";
import dns from "node:dns";
import { MongoClient } from "mongodb";

// Use Google DNS
dns.setServers(["8.8.8.8", "8.8.4.4"]);

if (!process.env.MONGO_URI) {
  throw new Error("MONGO_URI is missing from .env");
}

export const mongoClient = new MongoClient(process.env.MONGO_URI);

await mongoClient.connect();

export const db = mongoClient.db("stdiospace");

console.log("MongoDB Connected Successfully");
