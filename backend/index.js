import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import connectDB from "./utils/db.js";
import userRoute from "./routes/user.route.js";
import companyRoute from "./routes/company.route.js";
import jobRoute from "./routes/job.route.js";
import applicationRoute from "./routes/application.route.js";
import chatbotRoute from "./routes/chatbot.route.js";
import scrapedJobRoute from "./routes/scrapedJob.route.js";
import careerSourceRoute from "./routes/careerSource.route.js";
import statsRoute from "./routes/stats.route.js";
import savedJobRoute from "./routes/savedJob.route.js";
import dismissedJobRoute from "./routes/dismissedJob.route.js";
import alertRoute from "./routes/alert.route.js";
import trackedApplicationRoute from "./routes/trackedApplication.route.js";
import adminRoute from "./routes/admin.route.js";
import { startScrapeScheduler } from "./jobs/scrapeScheduler.js";
import { startAlertScheduler } from "./jobs/alertScheduler.js";
import { startLinkCheckScheduler } from "./jobs/linkCheckScheduler.js";
import { seedDefaultJobSources } from "./utils/seedJobSources.js";
import { User } from "./models/user.model.js";
import { isEmailConfigured } from "./services/email.service.js";
import { ensureAdminFromEnv } from "./utils/ensureAdmin.js";
import { apiLimiter } from "./middlewares/rateLimiter.js";
import { warmCatalog } from "./services/job-catalog/index.js";
dotenv.config({});
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Render / reverse proxies: use client IP for rate limiting
app.set("trust proxy", 1);

//middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

const allowedOrigins = new Set(
  [
    "https://www.joblelo.online",
    "https://joblelo.online",
    "https://job-vista-eta.vercel.app",
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    process.env.FRONTEND_URL,
  ]
    .filter(Boolean)
    .map((url) => url.replace(/\/$/, "")),
);

const isAllowedOrigin = (origin) => {
  if (!origin) return true;
  const normalized = origin.replace(/\/$/, "");
  if (allowedOrigins.has(normalized)) return true;
  try {
    const { hostname } = new URL(origin);
    if (hostname === "joblelo.online" || hostname.endsWith(".joblelo.online")) {
      return true;
    }
    if (hostname.endsWith(".vercel.app")) {
      return true;
    }
  } catch {
    return false;
  }
  return false;
};

app.use(
  cors({
    origin(origin, callback) {
      if (isAllowedOrigin(origin)) {
        return callback(null, true);
      }
      console.warn("[CORS] blocked origin:", origin);
      return callback(new Error("Not allowed by CORS"));
    },
    credentials: true,
  }),
);

app.use("/api/v1", apiLimiter);

app.use("/api/v1/user", userRoute);
app.use("/api/v1/company", companyRoute);
app.use("/api/v1/job", jobRoute);
app.use("/api/v1/application", applicationRoute);
app.use("/api/v1/chatbot", chatbotRoute);
app.use("/api/v1/scraped-jobs", scrapedJobRoute);
app.use("/api/v1/career-sources", careerSourceRoute);
app.use("/api/v1/stats", statsRoute);
app.use("/api/v1/saved-jobs", savedJobRoute);
app.use("/api/v1/dismissed-jobs", dismissedJobRoute);
app.use("/api/v1/alerts", alertRoute);
app.use("/api/v1/tracked-applications", trackedApplicationRoute);
app.use("/api/v1/admin", adminRoute);

app.get("/home", (req, res) => {
  return res.status(200).json({
    message: "I am coming form backend",
    success: true,
    auth: {
      emailConfigured: isEmailConfigured(),
      googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    },
  });
});

app.get("/health", (_req, res) => {
  return res.status(200).json({
    status: "ok",
    success: true,
    uptime: process.uptime(),
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, async () => {
  await connectDB();
  await User.updateMany(
    { emailVerified: { $exists: false } },
    { $set: { emailVerified: true, authProvider: "local" } },
  );
  await seedDefaultJobSources();
  await ensureAdminFromEnv();
  // Warm the job catalog cache in the background so the first visitor after a
  // deploy/restart gets a cache hit. Never blocks startup; failures are non-fatal.
  warmCatalog().catch((error) => {
    console.warn("[Catalog] warm-up failed (will load on first request):", error.message);
  });
  startScrapeScheduler();
  startAlertScheduler();
  startLinkCheckScheduler();
  console.log(`server is listening at ${PORT}`);
  console.log(
    `[Config] emailConfigured=${isEmailConfigured()} googleConfigured=${Boolean(process.env.GOOGLE_CLIENT_ID)}`,
  );
});
