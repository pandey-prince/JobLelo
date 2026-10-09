import { ScrapedJob } from "../models/scrapedJob.model.js";
import { JobSource } from "../models/jobSource.model.js";
import {
  syncAllSources,
  syncSourceById,
  syncSourcesByMode,
} from "../services/scrapeSync.service.js";
import { checkAllActiveJobLinks } from "../services/linkCheck.service.js";
import { hardDeleteScrapedJobsByQuery } from "../services/scrapedJobCleanup.service.js";
import {
  detectScraperType,
  extractCompanySlugFromUrl,
} from "../services/scrapers/index.js";
import { filterItJobs, isItJob } from "../utils/itJobFilter.js";
import { isIndiaJob } from "../utils/indiaJobFilter.js";
import { createOrGetJobSource } from "../services/careerSource.service.js";
import {
  getScrapedJobsForList,
  invalidateCatalog,
  mapScrapedJobForList,
} from "../services/job-catalog/index.js";
import { attachBadgesToJob } from "../utils/jobBadges.js";
import {
  cleanJobText,
  extractExperienceFromTitle,
  resolveExperienceLevel,
} from "../utils/jobText.js";
import { toPublicApplicationUrl } from "../utils/applicationUrl.js";
import { sanitizeSearchTerm } from "../utils/searchTerm.js";

export const listScrapedJobs = async (req, res) => {
  try {
    const keyword = sanitizeSearchTerm(req.query.keyword);
    const jobs = await getScrapedJobsForList(keyword);

    res.status(200).json({
      success: true,
      jobs,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const getScrapedJobById = async (req, res) => {
  try {
    const job = await ScrapedJob.findById(req.params.id).populate("source");
    if (!job || job.status !== "active" || !isItJob(job) || !isIndiaJob(job)) {
      return res.status(404).json({
        success: false,
        message: "Scraped job not found",
      });
    }

    res.status(200).json({
      success: true,
      job: attachBadgesToJob(
        {
          _id: `scraped-${job._id}`,
          scrapedJobId: job._id,
          title: job.title,
          description: cleanJobText(job.description),
          requirements: (job.requirements || []).map((item) => cleanJobText(String(item))),
          experienceLevel:
            job.experienceLevel ||
            resolveExperienceLevel(job) ||
            extractExperienceFromTitle(job.title) ||
            "Not specified",
          salary: job.salary,
          location: String(job.location || "").trim() || "Not specified",
          jobType: job.jobType,
          position: 1,
          company: {
            name: job.companyName,
            logo: job.companyLogo,
          },
          createdAt: job.firstSeenAt,
          lastSeenAt: job.lastSeenAt,
          applications: [],
          external: true,
          externalSource: job.source?.name || job.companyName,
          applicationLink: toPublicApplicationUrl(job.applicationUrl),
          sourceName: job.source?.name,
          sourceUrl: job.source?.url,
        },
        {
          sourceType: "career_page",
          sourceLabel: job.source?.name || job.companyName,
        },
      ),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const listJobSources = async (req, res) => {
  try {
    const sources = await JobSource.find().sort({ createdAt: -1 });
    res.status(200).json({
      success: true,
      sources,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const createJobSource = async (req, res) => {
  try {
    const { name, companyName, url, scraperType, selectors, isActive } = req.body;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "Career page URL is required",
      });
    }

    const { source, created } = await createOrGetJobSource({
      url,
      companyName,
      name,
      scraperType,
      selectors,
      sourceOrigin: "admin",
      submittedBy: req.id,
      isPublic: true,
      triggerSync: isActive !== false,
    });

    invalidateCatalog("source:create");

    res.status(created ? 201 : 200).json({
      success: true,
      message: created ? "Career page source added" : "Career page already exists",
      source,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const updateJobSource = async (req, res) => {
  try {
    const updates = { ...req.body };
    if (updates.url && !updates.scraperType) {
      updates.scraperType = detectScraperType(updates.url);
    }

    const source = await JobSource.findByIdAndUpdate(req.params.id, updates, {
      new: true,
    });

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Job source not found",
      });
    }

    invalidateCatalog("source:update");

    res.status(200).json({
      success: true,
      message: "Job source updated",
      source,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const deleteJobSource = async (req, res) => {
  try {
    const source = await JobSource.findByIdAndDelete(req.params.id);
    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Job source not found",
      });
    }

    await hardDeleteScrapedJobsByQuery({ source: source._id }, "source_deleted");
    invalidateCatalog("source:delete");

    res.status(200).json({
      success: true,
      message: "Job source removed",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const triggerFullSync = async (req, res) => {
  try {
    const summary = await syncAllSources();
    res.status(200).json({
      success: true,
      message: "Sync completed",
      summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const triggerOpsSync = async (req, res) => {
  try {
    const mode = String(req.query.mode || "api").toLowerCase();
    if (!["api", "puppeteer", "all"].includes(mode)) {
      return res.status(400).json({
        success: false,
        message: "Invalid mode. Use api, puppeteer, or all.",
      });
    }

    const summary = await syncSourcesByMode(mode, {
      runPostSyncTasks: mode !== "puppeteer",
    });

    return res.status(200).json({
      success: true,
      message: `${mode} sync completed`,
      summary,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const triggerSourceSync = async (req, res) => {
  try {
    const result = await syncSourceById(req.params.id);
    res.status(200).json({
      success: true,
      message: result.success ? "Source synced" : "Source sync failed",
      result,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const triggerLinkCheck = async (req, res) => {
  try {
    const summary = await checkAllActiveJobLinks();
    res.status(200).json({
      success: true,
      message: "Link check completed",
      summary,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};

export const detectSourceType = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({
        success: false,
        message: "URL is required",
      });
    }

    res.status(200).json({
      success: true,
      scraperType: detectScraperType(url),
      suggestedCompanyName: extractCompanySlugFromUrl(url),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
};
