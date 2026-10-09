import { Job } from "../models/job.model.js";
import {
  fetchExternalJobById,
  getCatalog,
  getScrapedJobsForList,
  isExternalJobId,
  memoizeOnCatalog,
} from "../services/job-catalog/index.js";
import { parseJobListFilters, filterJobList, sortJobList } from "../utils/jobListFilters.js";
import { recommendJobs } from "../utils/jobRecommendation.js";
import { sanitizeSearchTerm } from "../utils/searchTerm.js";
import { User } from "../models/user.model.js";
import { DismissedJob } from "../models/dismissedJob.model.js";
import {
  parsePagination,
  paginateArray,
} from "../utils/pagination.js";

export const postJob = async (req, res) => {
  try {
    const {
      title,
      description,
      requirements,
      salary,
      location,
      jobType,
      experience,
      position,
      companyId,
    } = req.body;

    const userId = req.id;

    if (
      !title ||
      !description ||
      !requirements ||
      !salary ||
      !location ||
      !position ||
      !jobType ||
      !companyId ||
      !experience
    ) {
      return res.status(400).json({
        message: "Something is missing",
        success: false,
      });
    }

    const job = await Job.create({
      title,
      description,
      requirements: requirements.split(","),
      salary: Number(salary),
      location,
      jobType,
      position,
      experienceLevel: experience,
      company: companyId,
      created_by: userId,
    });

    return res.status(201).json({
      message: "New job created Successfully",
      success: true,
      job,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to create job",
      success: false,
    });
  }
};

export const getAllJobs = async (req, res) => {
  try {
    const keyword = sanitizeSearchTerm(req.query.keyword);
    const filters = parseJobListFilters(req.query);
    const paginationQuery = parsePagination(req.query, {
      defaultLimit: 30,
      maxLimit: 48,
    });

    const scrapedJobs = await getScrapedJobsForList(keyword);
    let filteredJobs = filterJobList(scrapedJobs, keyword, filters);

    if (req.id) {
      const dismissed = await DismissedJob.find({ user: req.id }).select("jobKey").lean();
      if (dismissed.length) {
        const dismissedKeys = new Set(dismissed.map((entry) => entry.jobKey));
        filteredJobs = filteredJobs.filter((job) => !dismissedKeys.has(String(job._id)));
      }
    }

    const sortedJobs = sortJobList(filteredJobs, filters.sortBy);
    const { data: jobsPage, pagination } = paginateArray(sortedJobs, paginationQuery);

    res.status(200).json({
      jobs: jobsPage,
      pagination,
      success: true,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to fetch jobs",
      success: false,
    });
  }
};

export const getJobById = async (req, res) => {
  try {
    const jobId = req.params.id;

    if (isExternalJobId(jobId)) {
      const externalJob = await fetchExternalJobById(jobId);
      if (!externalJob) {
        return res.status(404).json({
          message: "External job not found",
          success: false,
        });
      }

      return res.status(200).json({
        job: externalJob,
        success: true,
      });
    }

    return res.status(404).json({
      message: "Job not found",
      success: false,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to fetch job",
      success: false,
    });
  }
};

export const getRecommendedJobs = async (req, res) => {
  try {
    const limit = Math.min(
      24,
      Math.max(1, parseInt(req.query.limit, 10) || 12),
    );

    let profile = {};
    if (req.id) {
      const user = await User.findById(req.id).select("profile.skills profile.preferredJobRoles");
      profile = user?.profile || {};
    }

    const personalized = Boolean(
      (profile.skills?.length || 0) > 0 || (profile.preferredJobRoles?.length || 0) > 0,
    );

    const catalog = await getCatalog();
    // Guests / empty profiles all get the same result, so memoise it per catalog version.
    const jobs = personalized
      ? recommendJobs(catalog.jobs, profile, { limit })
      : memoizeOnCatalog(`recommended:guest:${limit}`, catalog, () =>
          recommendJobs(catalog.jobs, {}, { limit }),
        );

    return res.status(200).json({
      success: true,
      jobs,
      personalized,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to fetch recommended jobs",
      success: false,
    });
  }
};

export const getAdminJobs = async (req, res) => {
  try {
    const adminId = req.id;
    const jobs = await Job.find({ created_by: adminId }).populate("company").sort({ createdAt: -1 });
    return res.status(200).json({
      jobs: jobs || [],
      success: true,
    });
  } catch (err) {
    console.log(err);
    return res.status(500).json({
      message: "Unable to fetch recruiter jobs",
      success: false,
    });
  }
};
