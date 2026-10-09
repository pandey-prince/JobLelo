import { ScrapedJob } from "../models/scrapedJob.model.js";
import { JobSource } from "../models/jobSource.model.js";
import { UserCompanyList } from "../models/userCompanyList.model.js";
import {
  buildCareerSubmitMessage,
  createOrGetJobSource,
} from "../services/careerSource.service.js";
import { parseCareerSourcesUpload } from "../utils/parseCareerSourcesInput.js";
import {
  detectScraperType,
  extractCompanySlugFromUrl,
} from "../services/scrapers/index.js";
import { mapScrapedJobForList, dedupeScrapedJobs, getScrapedJobsForList } from "../services/job-catalog/index.js";
import { escapeRegex, sanitizeSearchTerm } from "../utils/searchTerm.js";
import { filterItJobs } from "../utils/itJobFilter.js";
import { filterIndiaJobs } from "../utils/indiaJobFilter.js";
import {
  parsePagination,
  buildPaginationMeta,
  paginateArray,
} from "../utils/pagination.js";
import { companyNameMatchesSlug, slugifyCompanyName } from "../utils/companySlug.js";
import { parseJobListFilters, filterJobList, sortJobList } from "../utils/jobListFilters.js";
import {
  isBoardGoneScrapeError,
  shouldHideSourceFromPublicFeed,
  SOURCE_ERROR_HIDE_HOURS,
} from "../utils/sourceFeedHealth.js";

const parseTruthyQuery = (value) => {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

const companyGroupKey = (name = "") => String(name).trim().toLowerCase();

export const getCompanySourceJobs = async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) {
      return res.status(400).json({
        success: false,
        message: "Company slug is required",
      });
    }

    const sources = await JobSource.find({ isPublic: true, isActive: true });
    const source = sources.find((entry) => companyNameMatchesSlug(entry.companyName, slug));

    if (!source) {
      return res.status(404).json({
        success: false,
        message: "Company not found",
      });
    }

    const keyword = sanitizeSearchTerm(req.query.keyword);
    const filters = parseJobListFilters(req.query);
    const paginationQuery = parsePagination(req.query, {
      defaultLimit: 12,
      maxLimit: 48,
    });

    const query = { source: source._id, status: "active" };
    if (keyword) {
      const regex = { $regex: escapeRegex(keyword), $options: "i" };
      query.$or = [
        { title: regex },
        { description: regex },
        { location: regex },
        { companyName: regex },
      ];
    }

    const scrapedJobs = await ScrapedJob.find(query).populate("source").sort({ firstSeenAt: -1 });
    const mappedJobs = dedupeScrapedJobs(filterIndiaJobs(filterItJobs(scrapedJobs))).map(
      mapScrapedJobForList,
    );
    const filteredJobs = sortJobList(filterJobList(mappedJobs, keyword, filters), filters.sortBy);
    const { data: jobs, pagination } = paginateArray(filteredJobs, paginationQuery);

    const listingsMayBeOutdated = source.lastScrapeStatus === "error";
    const hiddenFromPublicFeed = shouldHideSourceFromPublicFeed(source);

    res.status(200).json({
      success: true,
      source: {
        _id: source._id,
        companyName: source.companyName,
        name: source.name,
        url: source.url,
        lastScrapedAt: source.lastScrapedAt,
        lastScrapeStatus: source.lastScrapeStatus,
        lastScrapeError: source.lastScrapeError || "",
        jobsFoundCount: source.jobsFoundCount,
        listingsMayBeOutdated,
        hiddenFromPublicFeed,
        sourceErrorHideHours: SOURCE_ERROR_HIDE_HOURS,
        boardGone: isBoardGoneScrapeError(source.lastScrapeError),
      },
      jobs,
      pagination,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listPublicSources = async (req, res) => {
  try {
    const search = sanitizeSearchTerm(req.query.search || req.query.keyword);
    const withJobs = parseTruthyQuery(req.query.withJobs);
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 20,
      maxLimit: 50,
    });

    if (withJobs) {
      // Build from the same job catalog the Jobs page uses so counts always match live openings.
      const catalogJobs = await getScrapedJobsForList(search);
      const groups = new Map();

      for (const job of catalogJobs) {
        const companyName = String(job?.company?.name || "").trim();
        if (!companyName) continue;
        const key = companyGroupKey(companyName);
        if (!groups.has(key)) {
          groups.set(key, {
            companyName,
            slug: slugifyCompanyName(companyName),
            jobs: [],
          });
        }
        groups.get(key).jobs.push(job);
      }

      let companies = Array.from(groups.values())
        .map((group) => ({
          ...group,
          activeJobCount: group.jobs.length,
        }))
        .filter((group) => group.activeJobCount > 0)
        .sort((a, b) => a.companyName.localeCompare(b.companyName));

      if (search) {
        const needle = search.toLowerCase();
        companies = companies.filter((company) =>
          company.companyName.toLowerCase().includes(needle),
        );
      }

      // Attach careers URL from JobSource when available
      const sourceDocs = await JobSource.find({
        isPublic: true,
        isActive: true,
      })
        .select("companyName name url lastScrapedAt lastScrapeStatus")
        .lean();

      const sourceBySlug = new Map();
      for (const source of sourceDocs) {
        const name = source.companyName || source.name || "";
        const slug = slugifyCompanyName(name);
        if (slug) sourceBySlug.set(slug, source);
      }

      companies = companies.map((company) => {
        const source = sourceBySlug.get(company.slug);
        return {
          _id: source?._id || company.slug,
          companyName: company.companyName,
          name: source?.name || company.companyName,
          url: source?.url || "",
          lastScrapedAt: source?.lastScrapedAt || null,
          lastScrapeStatus: source?.lastScrapeStatus || "",
          slug: company.slug,
          activeJobCount: company.activeJobCount,
          jobs: company.jobs,
        };
      });

      const { data: sources, pagination } = paginateArray(companies, {
        page,
        limit,
        skip,
      });

      return res.status(200).json({
        success: true,
        sources,
        pagination,
      });
    }

    const query = { isPublic: true };
    if (search) {
      const regex = { $regex: escapeRegex(search), $options: "i" };
      query.$or = [{ companyName: regex }, { name: regex }];
    }

    const [total, sources] = await Promise.all([
      JobSource.countDocuments(query),
      JobSource.find(query).sort({ companyName: 1 }).skip(skip).limit(limit),
    ]);

    res.status(200).json({
      success: true,
      sources,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const submitCareerSource = async (req, res) => {
  try {
    const { url, companyName, name, addToWatchlist } = req.body;
    const userId = req.id;

    if (!url) {
      return res.status(400).json({
        success: false,
        message: "Career page URL is required",
      });
    }

    const { source, created, queuedPuppeteer, workflowDispatched } =
      await createOrGetJobSource({
      url,
      companyName,
      name,
      sourceOrigin: "user",
      submittedBy: userId,
      isPublic: true,
      triggerSync: true,
    });

    let watchlistEntry = null;
    if (addToWatchlist !== false) {
      watchlistEntry = await UserCompanyList.findOneAndUpdate(
        { user: userId, jobSource: source._id, listType: "watchlist" },
        {
          user: userId,
          jobSource: source._id,
          companyName: source.companyName,
          careerUrl: source.url,
          listType: "watchlist",
          alertEnabled: true,
        },
        { upsert: true, new: true }
      );
    }

    res.status(created ? 201 : 200).json({
      success: true,
      message: buildCareerSubmitMessage({
        created,
        source,
        queuedPuppeteer,
        workflowDispatched,
      }),
      source,
      watchlistEntry,
      queuedPuppeteer: Boolean(queuedPuppeteer),
      workflowDispatched: Boolean(workflowDispatched),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const importCareerSourcesExcel = async (req, res) => {
  try {
    if (!req.file?.buffer) {
      return res.status(400).json({
        success: false,
        message: "Upload an Excel, CSV, or JSON file",
      });
    }

    const { region, companies } = parseCareerSourcesUpload(req.file);
    const isJson = String(req.file.originalname || "")
      .toLowerCase()
      .endsWith(".json");
    const results = [];

    for (const row of companies) {
      try {
        const rowRegion = row.region || region;
        const { source, created } = await createOrGetJobSource({
          url: row.careerUrl,
          companyName: row.companyName,
          name: row.name,
          scraperType: row.scraperType || undefined,
          sourceOrigin: isJson ? "json" : "excel",
          submittedBy: req.id,
          isPublic: true,
          triggerSync: false,
          regions: rowRegion ? [rowRegion] : [],
        });

        results.push({
          companyName: row.companyName,
          success: true,
          created,
          sourceId: source._id,
          isActive: source.isActive,
          regions: source.regions || [],
        });
      } catch (error) {
        results.push({
          companyName: row.companyName,
          success: false,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      success: true,
      message: `Processed ${results.length} companies from ${isJson ? "JSON" : "spreadsheet"}`,
      region: region || null,
      summary: {
        total: results.length,
        created: results.filter((r) => r.success && r.created).length,
        existing: results.filter((r) => r.success && !r.created).length,
        failed: results.filter((r) => !r.success).length,
        active: results.filter((r) => r.success && r.isActive).length,
      },
      results,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
};

export const detectCareerSourceType = async (req, res) => {
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
    res.status(500).json({ success: false, message: error.message });
  }
};

export const listUserCompanyLists = async (req, res) => {
  try {
    const userId = req.id;
    const listType = req.query.type || "watchlist";
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 10,
      maxLimit: 50,
    });

    const query = { user: userId };
    if (listType === "watchlist") {
      query.listType = { $in: ["watchlist", "wishlist"] };
    } else if (listType) {
      query.listType = listType;
    }

    const total = await UserCompanyList.countDocuments(query);
    const lists = await UserCompanyList.find(query)
      .populate("jobSource")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const enriched = await Promise.all(
      lists.map(async (entry) => {
        const jobCount = entry.jobSource?._id
          ? await ScrapedJob.countDocuments({
              source: entry.jobSource._id,
              status: "active",
            })
          : 0;

        return {
          ...entry.toObject(),
          activeJobCount: jobCount,
        };
      })
    );

    res.status(200).json({
      success: true,
      lists: enriched,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const addUserCompanyList = async (req, res) => {
  try {
    const userId = req.id;
    const {
      listType: requestedListType = "watchlist",
      jobSourceId,
      companyName,
      careerUrl,
      notes,
      createSource = true,
    } = req.body;

    const listType = "watchlist";

    if (requestedListType && !["watchlist", "wishlist"].includes(requestedListType)) {
      return res.status(400).json({
        success: false,
        message: "listType must be watchlist or wishlist",
      });
    }

    let source = null;

    if (jobSourceId) {
      source = await JobSource.findById(jobSourceId);
      if (!source) {
        return res.status(404).json({
          success: false,
          message: "Selected company source was not found",
        });
      }
    } else if (careerUrl && createSource) {
      const result = await createOrGetJobSource({
        url: careerUrl,
        companyName,
        sourceOrigin: "user",
        submittedBy: userId,
        isPublic: true,
        triggerSync: listType === "watchlist",
      });
      source = result.source;
    }

    if (!source && !companyName) {
      return res.status(400).json({
        success: false,
        message: "Provide a company name, career URL, or existing source",
      });
    }

    const resolvedCompanyName =
      source?.companyName || companyName || "Unknown Company";

    const duplicateQuery = source?._id
      ? { user: userId, jobSource: source._id, listType }
      : {
          user: userId,
          companyName: resolvedCompanyName,
          listType,
          jobSource: null,
        };

    const existing = await UserCompanyList.findOne(duplicateQuery);
    if (existing) {
      return res.status(200).json({
        success: true,
        message: "Company already in your list",
        list: existing,
      });
    }

    const list = await UserCompanyList.create({
      user: userId,
      jobSource: source?._id || null,
      companyName: resolvedCompanyName,
      careerUrl: careerUrl || source?.url || "",
      listType,
      notes: notes || "",
      alertEnabled: listType === "watchlist",
    });

    const populated = await UserCompanyList.findById(list._id).populate(
      "jobSource"
    );

    res.status(201).json({
      success: true,
      message: `Added to ${listType}`,
      list: populated,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(400).json({
        success: false,
        message: "Company already exists in this list",
      });
    }
    res.status(500).json({ success: false, message: error.message });
  }
};

export const updateUserCompanyList = async (req, res) => {
  try {
    const userId = req.id;
    const { alertEnabled } = req.body;

    const list = await UserCompanyList.findOne({
      _id: req.params.id,
      user: userId,
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: "List entry not found",
      });
    }

    if (typeof alertEnabled === "boolean") {
      list.alertEnabled = alertEnabled;
      await list.save();
    }

    return res.status(200).json({
      success: true,
      message: "Watchlist updated",
      list,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const removeUserCompanyList = async (req, res) => {
  try {
    const userId = req.id;
    const list = await UserCompanyList.findOneAndDelete({
      _id: req.params.id,
      user: userId,
    });

    if (!list) {
      return res.status(404).json({
        success: false,
        message: "List entry not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Removed from your list",
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

export const getUserCompanyListJobs = async (req, res) => {
  try {
    const userId = req.id;
    const listType = req.query.type || "watchlist";
    const keyword = sanitizeSearchTerm(req.query.keyword);
    const { page, limit, skip } = parsePagination(req.query, {
      defaultLimit: 8,
      maxLimit: 24,
    });

    const listQuery =
      listType === "watchlist"
        ? { user: userId, listType: { $in: ["watchlist", "wishlist"] } }
        : { user: userId, listType };

    const lists = await UserCompanyList.find(listQuery).populate("jobSource");

    const sourceIds = lists
      .map((entry) => entry.jobSource?._id)
      .filter(Boolean);

    if (!sourceIds.length) {
      return res.status(200).json({
        success: true,
        jobs: [],
        lists,
        pagination: buildPaginationMeta({ page, limit, total: 0 }),
      });
    }

    const query = { source: { $in: sourceIds }, status: "active" };
    if (keyword) {
      const regex = { $regex: escapeRegex(keyword), $options: "i" };
      query.$or = [
        { title: regex },
        { description: regex },
        { location: regex },
        { companyName: regex },
      ];
    }

    const total = await ScrapedJob.countDocuments(query);
    const scrapedJobs = await ScrapedJob.find(query)
      .populate("source")
      .sort({ firstSeenAt: -1 })
      .skip(skip)
      .limit(limit);

    const jobs = filterIndiaJobs(filterItJobs(scrapedJobs)).map(mapScrapedJobForList);

    res.status(200).json({
      success: true,
      jobs,
      lists,
      pagination: buildPaginationMeta({ page, limit, total }),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
