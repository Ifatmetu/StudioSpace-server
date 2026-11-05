import "dotenv/config";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";
import { db, mongoClient } from "./db.js";

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET is missing from .env");
}

const isProd = process.env.NODE_ENV === "production";

const cleanClientUrl = process.env.CLIENT_URL?.replace(/\/+$/, "");

export const auth = betterAuth({
  database: mongodbAdapter(db, {
    client: mongoClient,
  }),

  baseURL: process.env.BETTER_AUTH_URL?.replace(/\/+$/, ""),
  secret: process.env.BETTER_AUTH_SECRET,

  trustedOrigins: [
    cleanClientUrl,
    process.env.CLIENT_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://127.0.0.1:3000",
    "https://*.vercel.app",
  ].filter(Boolean),

  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
    requireEmailVerification: false,
  },

  // Google login (callback: {BETTER_AUTH_URL}/api/auth/callback/google)
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },

  advanced: {
    useSecureCookies: isProd,
    defaultCookieAttributes: {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
    },
  },

  plugins: [jwt()],
});
