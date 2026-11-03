
import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { toNodeHandler } from "better-auth/node";

import { auth } from "./auth.js";
import { db } from "./db.js";

const app = express();
const PORT = process.env.PORT || 5000;

// MongoDB collections
const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");

// CORS configuration
app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Better Auth handler
// IMPORTANT: Keep this before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

// Parse JSON for the remaining Express routes
app.use(express.json());

// Root route
app.get("/", (req, res) => {
  res.send("StdioSpace API is running");
});

// Test route
app.get("/test", (req, res) => {
  res.json({
    message: "API working successfully",
  });
});

// Get all public studios
app.get("/studios/public", async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({})
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(studios);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch studios",
      error: error.message,
    });
  }
});

// Get user's studios
app.get("/studios", async (req, res) => {
  try {
    const { userId, userEmail } = req.query;

    if (!userId && !userEmail) {
      return res.status(400).json({
        message: "userId or userEmail is required",
      });
    }

    const conditions = [];

    if (userId) {
      conditions.push(
        { userId: String(userId) },
        { ownerId: String(userId) },
        { createdBy: String(userId) }
      );
    }

    if (userEmail) {
      const email = String(userEmail).trim().toLowerCase();

      conditions.push(
        { userEmail: email },
        { ownerEmail: email },
        { hostEmail: email },
        { email: email },
        { createdBy: email }
      );
    }

    const studios = await studiosCollection
      .find({ $or: conditions })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(studios);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch user's studios",
      error: error.message,
    });
  }
});

// Add a studio
app.post("/studios", async (req, res) => {
  try {
    const studio = req.body;

    const ownerEmail = String(
      studio.userEmail ||
      studio.ownerEmail ||
      studio.hostEmail ||
      ""
    )
      .trim()
      .toLowerCase();

    const newStudio = {
      ...studio,
      userId: studio.userId ? String(studio.userId) : null,
      userEmail: ownerEmail,
      ownerEmail,
      createdBy: ownerEmail,
      createdAt: new Date(),
    };

    const result = await studiosCollection.insertOne(newStudio);

    res.status(201).json({
      message: "Studio added successfully",
      insertedId: result.insertedId,
    });
  } catch (error) {
    res.status(500).json({
      message: "Failed to add studio",
      error: error.message,
    });
  }
});

// Create a booking
app.post("/bookings", async (req, res) => {
  try {
    const {
      userId,
      userEmail,
      userName,
      studioId,
      studioTitle,
      studioImage,
      studioLocation,
      bookingDate,
      totalPrice,
    } = req.body;

    if (!userEmail || !studioId || !bookingDate) {
      return res.status(400).json({
        message: "Required booking information is missing",
      });
    }

    const parsedDate = new Date(`${bookingDate}T00:00:00`);

    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({
        message: "Invalid booking date",
      });
    }

    // Find the studio
    let studio = null;

    if (ObjectId.isValid(String(studioId))) {
      studio = await studiosCollection.findOne({
        _id: new ObjectId(String(studioId)),
      });
    }

    if (!studio) {
      studio = await studiosCollection.findOne({
        id: String(studioId),
      });
    }

    if (!studio) {
      return res.status(404).json({
        message: "Studio not found",
      });
    }

    // Get studio owner's email
    const hostEmail = String(
      studio.userEmail ||
      studio.ownerEmail ||
      studio.hostEmail ||
      studio.createdBy ||
      ""
    )
      .trim()
      .toLowerCase();

    if (!hostEmail) {
      return res.status(400).json({
        message: "Studio owner information is missing",
      });
    }

    const customerEmail = String(userEmail)
      .trim()
      .toLowerCase();

    // Prevent owner from booking their own studio
    if (customerEmail === hostEmail) {
      return res.status(400).json({
        message: "You cannot book your own studio",
      });
    }

    const booking = {
      userId: userId ? String(userId) : null,
      userEmail: customerEmail,
      userName: userName || "",

      studioId: String(studioId),
      studioTitle: studioTitle || studio.title || "",

      studioImage:
        studioImage ||
        studio.imageUrl ||
        studio.image ||
        "",

      studioLocation:
        studioLocation ||
        studio.location ||
        "",

      hostEmail,

      bookingDate: parsedDate,
      totalPrice: Number(totalPrice) || 0,

      status: "pending",
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);

    res.status(201).json({
      message: "Booking request submitted successfully",
      bookingId: result.insertedId,
      booking: {
        ...booking,
        _id: result.insertedId,
      },
    });
  } catch (error) {
    console.error("Booking error:", error);

    res.status(500).json({
      message: "Failed to create booking",
      error: error.message,
    });
  }
});

// Get bookings
// Default: Customer's bookings
// role=host: Booking requests for the studio owner
app.get("/bookings", async (req, res) => {
  try {
    const { userEmail, userId, role } = req.query;

    if (!userEmail && !userId) {
      return res.status(400).json({
        message: "userEmail or userId is required",
      });
    }

    const email = userEmail
      ? String(userEmail).trim().toLowerCase()
      : "";

    let filter = {};

    if (role === "host") {
      if (!email) {
        return res.status(400).json({
          message: "userEmail is required for booking requests",
        });
      }

      filter = {
        hostEmail: email,
      };
    } else {
      const conditions = [];

      if (email) {
        conditions.push({
          userEmail: email,
        });
      }

      if (userId) {
        conditions.push({
          userId: String(userId),
        });
      }

      filter = {
        $or: conditions,
      };
    }

    const bookings = await bookingsCollection
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(bookings);
  } catch (error) {
    console.error("Fetch bookings error:", error);

    res.status(500).json({
      message: "Failed to fetch bookings",
      error: error.message,
    });
  }
});

// Accept or decline a booking request
app.patch("/bookings/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { hostEmail, status } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    if (!hostEmail) {
      return res.status(400).json({
        message: "Host email is required",
      });
    }

    if (!["accepted", "declined"].includes(status)) {
      return res.status(400).json({
        message: "Status must be accepted or declined",
      });
    }

    const ownerEmail = String(hostEmail)
      .trim()
      .toLowerCase();

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        hostEmail: ownerEmail,
        status: "pending",
      },
      {
        $set: {
          status,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Booking request not found or already processed",
      });
    }

    res.status(200).json({
      message: `Booking ${status} successfully`,
    });
  } catch (error) {
    console.error("Booking status update error:", error);

    res.status(500).json({
      message: "Failed to update booking status",
      error: error.message,
    });
  }
});

// Cancel a booking (Customer)
app.patch("/bookings/:id/cancel", async (req, res) => {
  try {
    const { id } = req.params;
    const { userEmail } = req.body;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({
        message: "Invalid booking ID",
      });
    }

    if (!userEmail) {
      return res.status(400).json({
        message: "userEmail is required",
      });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: new ObjectId(id),
        userEmail: String(userEmail).trim().toLowerCase(),
        status: "pending",
      },
      {
        $set: {
          status: "cancelled",
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Booking not found or cannot be cancelled",
      });
    }

    res.status(200).json({
      message: "Booking cancelled successfully",
    });
  } catch (error) {
    console.error("Cancel booking error:", error);

    res.status(500).json({
      message: "Failed to cancel booking",
      error: error.message,
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
