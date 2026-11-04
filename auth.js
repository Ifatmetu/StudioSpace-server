import "dotenv/config";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { jwt } from "better-auth/plugins";
import { db, mongoClient } from "./db.js";

if (!process.env.BETTER_AUTH_SECRET) {
  throw new Error("BETTER_AUTH_SECRET is missing from .env");
}

const isProd = process.env.NODE_ENV === "production";

export const auth = betterAuth({
  database: mongodbAdapter(db, {
    client: mongoClient,
  }),

  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  trustedOrigins: [process.env.CLIENT_URL].filter(Boolean),

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

  // Challenge 1: session cookie is always HTTPOnly.
  // In production (client and server on different domains) it needs SameSite=None + Secure.
  advanced: {
    defaultCookieAttributes: {
      httpOnly: true,
      secure: isProd,
      sameSite: isProd ? "none" : "lax",
    },
  },

  plugins: [jwt()],
});