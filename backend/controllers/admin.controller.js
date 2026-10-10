import {
  clearCatalogCache,
  clearExternalCache,
  getCatalogCacheStats,
  getExternalCacheStats,
  warmCatalog,
} from "../services/job-catalog/index.js";
import { getAdminDashboard, getAdminSourcesList } from "../services/adminDashboard.service.js";

export const fetchAdminDashboard = async (req, res) => {
  try {
    const data = await getAdminDashboard(req.query);
    return res.status(200).json({
      success: true,
      ...data,
    });
  } catch (error) {
    console.error("[Admin] dashboard failed:", error.message, error.stack);
    return res.status(500).json({
      success: false,
      message: "Unable to load admin dashboard",
    });
  }
};

export const fetchAdminSources = async (req, res) => {
  try {
    const sources = await getAdminSourcesList();
    return res.status(200).json({
      success: true,
      sources,
    });
  } catch (error) {
    console.error("[Admin] sources list failed:", error.message);
    return res.status(500).json({
      success: false,
      message: "Unable to load sources",
    });
  }
};

/** Cache status for the job catalog and external-listing caches (admin only). */
export const getCacheStatus = async (req, res) => {
  try {
    return res.status(200).json({
      success: true,
      cache: {
        catalog: getCatalogCacheStats(),
        externalJobs: getExternalCacheStats(),
        config: {
          CATALOG_CACHE_TTL_MS: process.env.CATALOG_CACHE_TTL_MS ?? "default (300000)",
          CATALOG_CACHE_STALE_MS: process.env.CATALOG_CACHE_STALE_MS ?? "default (1800000)",
          EXTERNAL_JOBS_CACHE_TTL_MS: process.env.EXTERNAL_JOBS_CACHE_TTL_MS ?? "default (1200000)",
        },
        memory: {
          heapUsedMB: Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)),
          rssMB: Number((process.memoryUsage().rss / 1024 / 1024).toFixed(1)),
        },
      },
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};

/** Drop all caches and rebuild the catalog now (admin only). */
export const clearCaches = async (req, res) => {
  try {
    clearCatalogCache();
    clearExternalCache();
    const warmed = await warmCatalog();
    return res.status(200).json({
      success: true,
      message: "Caches cleared and catalog rebuilt",
      catalog: warmed,
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message });
  }
};
