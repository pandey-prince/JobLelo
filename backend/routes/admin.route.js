import express from "express";
import isAuthenticated from "../middlewares/isAuthenticated.js";
import { requireAnyRole } from "../middlewares/requireRole.js";
import {
  fetchAdminDashboard,
  fetchAdminSources,
  getCacheStatus,
  clearCaches,
} from "../controllers/admin.controller.js";

const router = express.Router();

router.use(isAuthenticated, requireAnyRole("admin"));

router.route("/dashboard").get(fetchAdminDashboard);
router.route("/sources").get(fetchAdminSources);
router.route("/cache").get(getCacheStatus);
router.route("/cache/clear").post(clearCaches);

export default router;
