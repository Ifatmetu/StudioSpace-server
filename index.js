import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { toNodeHandler, fromNodeHeaders } from "better-auth/node";

import { auth } from "./auth.js";
import { db } from "./db.js";

const app = express();
const PORT = process.env.PORT || 5000;

const studiosCollection = db.collection("studios");
const bookingsCollection = db.collection("bookings");
const reviewsCollection = db.collection("reviews");
const wishlistCollection = db.collection("wishlists");

const AUTH_URL = process.env.BETTER_AUTH_URL;

if (!AUTH_URL) {
  throw new Error("BETTER_AUTH_URL is missing from .env");
}

const JWKS = createRemoteJWKSet(new URL(`${AUTH_URL}/api/auth/jwks`));

// ======================================
// MIDDLEWARE
// ======================================

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Better Auth handler must be before express.json()
app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());

// ======================================
// HELPERS
// ======================================

const BOOKING_STATUS = {
  PENDING: "Pending",
  CONFIRMED: "Confirmed",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
};

// Which status can move to which (used by the host)
const ALLOWED_TRANSITIONS = {
  Pending: ["Confirmed", "Cancelled"],
  Confirmed: ["Completed", "Cancelled"],
};

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/; // HH:mm (24h)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/; // YYYY-MM-DD

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function toObjectId(id) {
  return ObjectId.isValid(String(id)) ? new ObjectId(String(id)) : null;
}

async function findStudioById(id) {
  const objectId = toObjectId(id);
  if (!objectId) return null;
  return studiosCollection.findOne({ _id: objectId });
}

function isStudioOwner(studio, user) {
  const ownerEmail = normalizeEmail(
    studio.ownerEmail || studio.userEmail || studio.hostEmail
  );
  return (
    (studio.userId && studio.userId === user.id) ||
    (ownerEmail && ownerEmail === user.email)
  );
}

// Only allow known fields (client can never set rating, owner, etc.)
function pickStudioFields(body) {
  const asNumber = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const asString = (v) => String(v ?? "").trim();
  const asStringArray = (v) =>
    Array.isArray(v) ? v.map((x) => asString(x)).filter(Boolean).slice(0, 30) : [];

  return {
    title: asString(body.title),
    category: asString(body.category),
    hourlyRate: asNumber(body.hourlyRate ?? body.price),
    securityDeposit: asNumber(body.securityDeposit ?? body.deposit),
    maxCapacity: asNumber(body.maxCapacity ?? body.capacity),
    location: asString(body.location),
    imageUrl: asString(body.imageUrl ?? body.image),
    gallery: asStringArray(body.gallery),
    amenities: asStringArray(body.amenities),
    description: asString(body.description ?? body.overview),
  };
}

function validateStudioFields(fields) {
  if (!fields.title) return "Title is required";
  if (!fields.category) return "Category is required";
  if (fields.hourlyRate <= 0) return "Hourly rate must be greater than 0";
  if (fields.maxCapacity <= 0) return "Max capacity must be greater than 0";
  if (!fields.location) return "Location is required";
  if (!fields.imageUrl) return "Image URL is required";
  if (!fields.description) return "Description is required";
  return null;
}

// Challenge 2: find a CONFIRMED booking that overlaps the requested slot
// Overlap rule: existing.start < new.end  AND  existing.end > new.start
async function findConfirmedOverlap({
  studioId,
  bookingDate,
  startTime,
  endTime,
  excludeId,
}) {
  const filter = {
    studioId: String(studioId),
    bookingDate,
    status: BOOKING_STATUS.CONFIRMED,
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  };

  if (excludeId) filter._id = { $ne: excludeId };

  return bookingsCollection.findOne(filter);
}

async function refreshStudioRating(studioId) {
  const [stats] = await reviewsCollection
    .aggregate([
      { $match: { studioId: String(studioId) } },
      { $group: { _id: null, avg: { $avg: "$rating" }, count: { $sum: 1 } } },
    ])
    .toArray();

  await studiosCollection.updateOne(
    { _id: new ObjectId(String(studioId)) },
    {
      $set: {
        rating: stats ? Math.round(stats.avg * 10) / 10 : 0,
        reviewCount: stats ? stats.count : 0,
      },
    }
  );
}

// ======================================
// AUTHENTICATION (Challenge 1)
// Accepts either:
//   1) Authorization: Bearer <JWT>  (verified with Better Auth JWKS)
//   2) HTTPOnly session cookie       (verified by Better Auth)
// Anything else -> 401 Unauthorized
// ======================================

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    // 1) JWT from Authorization header
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.split(" ")[1];

      if (!token) {
        return res.status(401).json({ message: "Invalid authentication token" });
      }

      const { payload } = await jwtVerify(token, JWKS, {
        issuer: AUTH_URL,
        audience: AUTH_URL,
      });

      if (typeof payload.sub !== "string" || typeof payload.email !== "string") {
        return res
          .status(401)
          .json({ message: "Invalid user information in token" });
      }

      req.user = {
        id: payload.sub,
        email: normalizeEmail(payload.email),
        name: typeof payload.name === "string" ? payload.name : "",
      };

      return next();
    }

    // 2) HTTPOnly session cookie
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });

    if (!session?.user) {
      return res.status(401).json({ message: "Authentication is required" });
    }

    req.user = {
      id: session.user.id,
      email: normalizeEmail(session.user.email),
      name: session.user.name || "",
    };

    next();
  } catch (error) {
    console.error("Authentication failed:", error.message);

    return res.status(401).json({
      message: "Invalid or expired authentication",
    });
  }
}


app.get("/", (req, res) => {
  res.send("StudioSpace API is running");
});

app.get("/test", (req, res) => {
  res.json({ message: "API working successfully" });
});

// All studios with search / category filter / sort
// GET /studios/public?search=loft&category=Photo%20Studio&sort=price-low&minPrice=10&maxPrice=100
app.get("/studios/public", async (req, res) => {
  try {
    const { search, category, sort, minPrice, maxPrice } = req.query;
    const filter = {};

    if (category && category !== "All") {
      filter.category = String(category);
    }

    if (search) {
      const regex = new RegExp(escapeRegex(String(search).trim()), "i");
      filter.$or = [{ title: regex }, { location: regex }, { category: regex }];
    }

    if (minPrice || maxPrice) {
      filter.hourlyRate = {};
      if (minPrice) filter.hourlyRate.$gte = Number(minPrice);
      if (maxPrice) filter.hourlyRate.$lte = Number(maxPrice);
    }

    const sortOptions = {
      "price-low": { hourlyRate: 1 },
      "price-high": { hourlyRate: -1 },
      rating: { rating: -1, createdAt: -1 },
      newest: { createdAt: -1 },
    };

    const studios = await studiosCollection
      .find(filter)
      .sort(sortOptions[sort] || sortOptions.newest)
      .toArray();

    res.status(200).json(studios);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch studios",
      error: error.message,
    });
  }
});

// Featured studios for Home page (6 top-rated, then newest)
app.get("/studios/featured", async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({})
      .sort({ rating: -1, createdAt: -1 })
      .limit(6)
      .toArray();

    res.status(200).json(studios);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch featured studios",
      error: error.message,
    });
  }
});

// Logged-in user's own studios (My Listings)
app.get("/studios", requireAuth, async (req, res) => {
  try {
    const studios = await studiosCollection
      .find({
        $or: [
          { userId: req.user.id },
          { ownerEmail: req.user.email },
          { userEmail: req.user.email },
        ],
      })
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

// Add studio
app.post("/studios", requireAuth, async (req, res) => {
  try {
    const fields = pickStudioFields(req.body);
    const validationError = validateStudioFields(fields);

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    const newStudio = {
      ...fields,
      price: fields.hourlyRate,
      deposit: fields.securityDeposit,
      capacity: fields.maxCapacity,
      image: fields.imageUrl,
      overview: fields.description,
      rating: 0,
      reviewCount: 0,
      reviewsCount: 0,
      userId: req.user.id,
      ownerName: req.user.name,
      ownerEmail: req.user.email,
      userEmail: req.user.email,
      createdAt: new Date(),
      updatedAt: new Date(),
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

// Studio details (public)
app.get("/studios/:id", async (req, res) => {
  try {
    const studio = await findStudioById(req.params.id);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    res.status(200).json(studio);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch studio",
      error: error.message,
    });
  }
});

// Update studio (owner only)
app.put("/studios/:id", requireAuth, async (req, res) => {
  try {
    const studio = await findStudioById(req.params.id);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    if (!isStudioOwner(studio, req.user)) {
      return res
        .status(403)
        .json({ message: "You can only update your own studios" });
    }

    const fields = pickStudioFields(req.body);
    const validationError = validateStudioFields(fields);

    if (validationError) {
      return res.status(400).json({ message: validationError });
    }

    await studiosCollection.updateOne(
      { _id: studio._id },
      {
        $set: {
          ...fields,
          price: fields.hourlyRate,
          deposit: fields.securityDeposit,
          capacity: fields.maxCapacity,
          image: fields.imageUrl,
          overview: fields.description,
          updatedAt: new Date(),
        },
      }
    );

    res.status(200).json({ message: "Studio updated successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to update studio",
      error: error.message,
    });
  }
});

// Delete studio (owner only)
app.delete("/studios/:id", requireAuth, async (req, res) => {
  try {
    const studio = await findStudioById(req.params.id);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    if (!isStudioOwner(studio, req.user)) {
      return res
        .status(403)
        .json({ message: "You can only delete your own studios" });
    }

    await studiosCollection.deleteOne({ _id: studio._id });

    // Clean up related data
    await bookingsCollection.updateMany(
      { studioId: String(studio._id), status: BOOKING_STATUS.PENDING },
      {
        $set: {
          status: BOOKING_STATUS.CANCELLED,
          updatedAt: new Date(),
        },
      }
    );
    await reviewsCollection.deleteMany({ studioId: String(studio._id) });
    await wishlistCollection.deleteMany({ studioId: String(studio._id) });

    res.status(200).json({ message: "Studio deleted successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to delete studio",
      error: error.message,
    });
  }
});

app.get("/studios/:id/reviews", async (req, res) => {
  try {
    if (!toObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid studio ID" });
    }

    const reviews = await reviewsCollection
      .find({ studioId: String(req.params.id) })
      .sort({ createdAt: -1 })
      .toArray();

    res.status(200).json(reviews);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch reviews",
      error: error.message,
    });
  }
});

// One review per user per studio (posting again updates it)
app.post("/studios/:id/reviews", requireAuth, async (req, res) => {
  try {
    const studio = await findStudioById(req.params.id);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    if (isStudioOwner(studio, req.user)) {
      return res
        .status(400)
        .json({ message: "You cannot review your own studio" });
    }

    const rating = Number(req.body.rating);
    const comment = String(req.body.comment || "").trim();

    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res
        .status(400)
        .json({ message: "Rating must be a whole number from 1 to 5" });
    }

    if (!comment) {
      return res.status(400).json({ message: "Review comment is required" });
    }

    await reviewsCollection.updateOne(
      { studioId: String(studio._id), userId: req.user.id },
      {
        $set: {
          userName: req.user.name,
          userEmail: req.user.email,
          rating,
          comment,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      { upsert: true }
    );

    await refreshStudioRating(studio._id);

    res.status(201).json({ message: "Review submitted successfully" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to submit review",
      error: error.message,
    });
  }
});



// Create booking request  (status: Pending)
// body: { studioId, bookingDate: "YYYY-MM-DD", startTime: "HH:mm", endTime: "HH:mm" }
app.post("/bookings", requireAuth, async (req, res) => {
  try {
    const { studioId, bookingDate, startTime, endTime } = req.body;

    if (!studioId || !bookingDate || !startTime || !endTime) {
      return res.status(400).json({
        message: "Studio, date, start time and end time are required",
      });
    }

    if (
      !DATE_RE.test(bookingDate) ||
      Number.isNaN(new Date(`${bookingDate}T00:00:00Z`).getTime())
    ) {
      return res.status(400).json({ message: "Invalid booking date" });
    }

    if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) {
      return res.status(400).json({ message: "Time must be in HH:mm format" });
    }

    if (endTime <= startTime) {
      return res
        .status(400)
        .json({ message: "End time must be after start time" });
    }

    // Reject past dates (1 day grace for timezone differences)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);

    if (bookingDate < yesterday) {
      return res
        .status(400)
        .json({ message: "You cannot book a date in the past" });
    }

    const studio = await findStudioById(studioId);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    const hostEmail = normalizeEmail(
      studio.ownerEmail || studio.userEmail || studio.hostEmail
    );

    if (!hostEmail) {
      return res
        .status(400)
        .json({ message: "Studio owner information is missing" });
    }

    if (isStudioOwner(studio, req.user)) {
      return res
        .status(400)
        .json({ message: "You cannot book your own studio" });
    }

    // Challenge 2: double-booking prevention
    const conflict = await findConfirmedOverlap({
      studioId: studio._id,
      bookingDate,
      startTime,
      endTime,
    });

    if (conflict) {
      return res.status(409).json({
        message: `This slot is already booked (${conflict.startTime} - ${conflict.endTime} on ${bookingDate}). Please choose a different time.`,
      });
    }

    // Same user, same slot, still pending
    const duplicate = await bookingsCollection.findOne({
      userId: req.user.id,
      studioId: String(studio._id),
      bookingDate,
      startTime,
      endTime,
      status: BOOKING_STATUS.PENDING,
    });

    if (duplicate) {
      return res.status(409).json({
        message: "You already have a pending request for this slot",
      });
    }

    // Price is calculated on the server, never trusted from the client
    const [sh, sm] = startTime.split(":").map(Number);
    const [eh, em] = endTime.split(":").map(Number);
    const hours = (eh * 60 + em - (sh * 60 + sm)) / 60;
    const hourlyRate = Number(studio.hourlyRate ?? studio.price) || 0;
    const securityDeposit = Number(studio.securityDeposit) || 0;

    const booking = {
      userId: req.user.id,
      userEmail: req.user.email,
      userName: req.user.name,

      hostId: studio.userId || "",
      hostEmail,

      studioId: String(studio._id),
      studioTitle: studio.title || "",
      studioImage: studio.imageUrl || "",
      studioLocation: studio.location || "",

      bookingDate,
      startTime,
      endTime,
      hours,
      hourlyRate,
      securityDeposit,
      totalPrice: hours * hourlyRate + securityDeposit,

      status: BOOKING_STATUS.PENDING,

      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);

    res.status(201).json({
      message: "Booking request submitted successfully. Waiting for host approval.",
      booking: { ...booking, _id: result.insertedId },
    });
  } catch (error) {
    console.error("Create booking error:", error);

    res.status(500).json({
      message: "Failed to create booking request",
      error: error.message,
    });
  }
});

// Default: my bookings. ?role=host -> requests received on my studios
app.get("/bookings", requireAuth, async (req, res) => {
  try {
    const filter =
      req.query.role === "host"
        ? { $or: [{ hostId: req.user.id }, { hostEmail: req.user.email }] }
        : { $or: [{ userId: req.user.id }, { userEmail: req.user.email }] };

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

// Booked slots of a studio on a date (so the UI can show unavailable times)
// GET /studios/:id/availability?date=YYYY-MM-DD
app.get("/studios/:id/availability", async (req, res) => {
  try {
    const { date } = req.query;

    if (!toObjectId(req.params.id) || !DATE_RE.test(String(date || ""))) {
      return res
        .status(400)
        .json({ message: "Valid studio ID and date (YYYY-MM-DD) are required" });
    }

    const slots = await bookingsCollection
      .find(
        {
          studioId: String(req.params.id),
          bookingDate: String(date),
          status: BOOKING_STATUS.CONFIRMED,
        },
        { projection: { startTime: 1, endTime: 1 } }
      )
      .sort({ startTime: 1 })
      .toArray();

    res.status(200).json(slots);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch availability",
      error: error.message,
    });
  }
});

// Host changes status: Confirmed | Cancelled (decline) | Completed
app.patch("/bookings/:id/status", requireAuth, async (req, res) => {
  try {
    const bookingId = toObjectId(req.params.id);
    let { status } = req.body;

    if (!bookingId) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    if (typeof status === "string") {
      const lower = status.toLowerCase();
      if (lower === "accepted" || lower === "confirmed") status = BOOKING_STATUS.CONFIRMED;
      else if (lower === "declined" || lower === "cancelled" || lower === "canceled") status = BOOKING_STATUS.CANCELLED;
      else if (lower === "completed") status = BOOKING_STATUS.COMPLETED;
    }

    if (
      ![
        BOOKING_STATUS.CONFIRMED,
        BOOKING_STATUS.CANCELLED,
        BOOKING_STATUS.COMPLETED,
      ].includes(status)
    ) {
      return res.status(400).json({
        message: "Status must be Confirmed, Cancelled or Completed",
      });
    }

    const booking = await bookingsCollection.findOne({ _id: bookingId });

    if (
      !booking ||
      !(booking.hostId === req.user.id || booking.hostEmail === req.user.email)
    ) {
      return res.status(404).json({ message: "Booking request not found" });
    }

    if (!(ALLOWED_TRANSITIONS[booking.status] || []).includes(status)) {
      return res.status(400).json({
        message: `A ${booking.status} booking cannot be changed to ${status}`,
      });
    }

    // Re-check collision at confirm time (another booking may have been confirmed meanwhile)
    if (status === BOOKING_STATUS.CONFIRMED) {
      const conflict = await findConfirmedOverlap({
        studioId: booking.studioId,
        bookingDate: booking.bookingDate,
        startTime: booking.startTime,
        endTime: booking.endTime,
        excludeId: booking._id,
      });

      if (conflict) {
        return res.status(409).json({
          message: `Cannot confirm: this slot overlaps with a confirmed booking (${conflict.startTime} - ${conflict.endTime}).`,
        });
      }
    }

    await bookingsCollection.updateOne(
      { _id: booking._id, status: booking.status },
      { $set: { status, updatedAt: new Date() } }
    );

    res.status(200).json({
      message: `Booking marked as ${status}`,
      status,
    });
  } catch (error) {
    console.error("Booking status update error:", error);

    res.status(500).json({
      message: "Failed to update booking status",
      error: error.message,
    });
  }
});

// Customer cancels own Pending booking
app.patch("/bookings/:id/cancel", requireAuth, async (req, res) => {
  try {
    const bookingId = toObjectId(req.params.id);

    if (!bookingId) {
      return res.status(400).json({ message: "Invalid booking ID" });
    }

    const result = await bookingsCollection.updateOne(
      {
        _id: bookingId,
        $or: [{ userId: req.user.id }, { userEmail: req.user.email }],
        status: { $in: [BOOKING_STATUS.PENDING, "pending", "Pending"] },
      },
      {
        $set: { status: BOOKING_STATUS.CANCELLED, updatedAt: new Date() },
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Booking not found or cannot be cancelled",
      });
    }

    res.status(200).json({ message: "Booking cancelled successfully" });
  } catch (error) {
    console.error("Cancel booking error:", error);

    res.status(500).json({
      message: "Failed to cancel booking",
      error: error.message,
    });
  }
});


app.get("/wishlist", requireAuth, async (req, res) => {
  try {
    const items = await wishlistCollection
      .find({ userId: req.user.id })
      .sort({ createdAt: -1 })
      .toArray();

    const ids = items
      .map((item) => toObjectId(item.studioId))
      .filter(Boolean);

    const studios = ids.length
      ? await studiosCollection.find({ _id: { $in: ids } }).toArray()
      : [];

    res.status(200).json(studios);
  } catch (error) {
    res.status(500).json({
      message: "Failed to fetch wishlist",
      error: error.message,
    });
  }
});

app.post("/wishlist/:studioId", requireAuth, async (req, res) => {
  try {
    const studio = await findStudioById(req.params.studioId);

    if (!studio) {
      return res.status(404).json({ message: "Studio not found" });
    }

    await wishlistCollection.updateOne(
      { userId: req.user.id, studioId: String(studio._id) },
      { $setOnInsert: { createdAt: new Date() } },
      { upsert: true }
    );

    res.status(201).json({ message: "Studio saved to wishlist" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to save studio",
      error: error.message,
    });
  }
});

app.delete("/wishlist/:studioId", requireAuth, async (req, res) => {
  try {
    await wishlistCollection.deleteOne({
      userId: req.user.id,
      studioId: String(req.params.studioId),
    });

    res.status(200).json({ message: "Studio removed from wishlist" });
  } catch (error) {
    res.status(500).json({
      message: "Failed to remove studio",
      error: error.message,
    });
  }
});


app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Something went wrong on the server" });
});

// ======================================
// START SERVER
// ======================================

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;