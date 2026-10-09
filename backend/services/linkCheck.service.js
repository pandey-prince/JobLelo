import { ScrapedJob } from "../models/scrapedJob.model.js";
import { classifyLinkCheckResult } from "../utils/deadJobHeuristics.js";
import { hardDeleteScrapedJob } from "./scrapedJobCleanup.service.js";
import { withCatalogInvalidation } from "./job-catalog/index.js";

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

const LINK_CHECK_TIMEOUT_MS = Number(process.env.LINK_CHECK_TIMEOUT_MS || 10000);
const LINK_CHECK_FAIL_THRESHOLD = Number(process.env.LINK_CHECK_FAIL_THRESHOLD || 3);
const LINK_CHECK_DELAY_MS = Number(process.env.LINK_CHECK_DELAY_MS || 1000);
const LINK_CHECK_BATCH_SIZE = Number(process.env.LINK_CHECK_BATCH_SIZE || 50);
const MAX_BODY_BYTES = 120000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const fetchWithTimeout = async (url, method = "HEAD") => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LINK_CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      signal: controller.signal,
      headers: DEFAULT_HEADERS,
    });

    let body = "";
    if (method === "GET") {
      const buffer = await response.arrayBuffer();
      body = new TextDecoder("utf-8", { fatal: false }).decode(
        buffer.slice(0, MAX_BODY_BYTES),
      );
    }

    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
};

export const probeApplicationUrl = async (url) => {
  try {
    const headResult = await fetchWithTimeout(url, "HEAD");
    const headClassification = classifyLinkCheckResult(headResult);

    if (headClassification.status === "dead") {
      return { ...headClassification, httpStatus: headResult.status };
    }

    if (headClassification.status === "alive") {
      return { ...headClassification, httpStatus: headResult.status };
    }

    const getResult = await fetchWithTimeout(url, "GET");
    const getClassification = classifyLinkCheckResult(getResult);
    return { ...getClassification, httpStatus: getResult.status };
  } catch (error) {
    return {
      status: "inconclusive",
      reason: error.name === "AbortError" ? "timeout" : "network_error",
      httpStatus: 0,
    };
  }
};

export const checkScrapedJobLink = async (job) => {
  const now = new Date();
  const probe = await probeApplicationUrl(job.applicationUrl);

  job.lastLinkCheckedAt = now;
  job.linkHttpStatus = probe.httpStatus || 0;
  job.linkCheckReason = probe.reason || probe.status;

  if (probe.status === "alive") {
    job.linkFailCount = 0;
    await job.save();
    return { job, action: "kept", probe };
  }

  if (probe.status === "dead") {
    job.linkFailCount = (job.linkFailCount || 0) + 1;
    await job.save();

    if (job.linkFailCount >= LINK_CHECK_FAIL_THRESHOLD) {
      await hardDeleteScrapedJob(job, "dead_link");
      return { job, action: "deleted", probe };
    }

    return { job, action: "failed", probe };
  }

  if (probe.status === "inconclusive") {
    await job.save();
    return { job, action: "inconclusive", probe };
  }

  await job.save();
  return { job, action: "inconclusive", probe };
};

export const checkActiveJobLinks = async ({
  limit = LINK_CHECK_BATCH_SIZE,
  onlyStaleHours = null,
} = {}) => {
  const query = { status: "active" };

  if (onlyStaleHours) {
    const cutoff = new Date(Date.now() - onlyStaleHours * 60 * 60 * 1000);
    query.$or = [
      { lastLinkCheckedAt: { $exists: false } },
      { lastLinkCheckedAt: { $lt: cutoff } },
    ];
  }

  const jobs = await ScrapedJob.find(query)
    .sort({ lastLinkCheckedAt: 1, updatedAt: 1 })
    .limit(limit);

  const summary = {
    checked: 0,
    kept: 0,
    deleted: 0,
    failed: 0,
    inconclusive: 0,
  };

  for (const job of jobs) {
    const result = await checkScrapedJobLink(job);
    summary.checked += 1;

    if (result.action === "kept") summary.kept += 1;
    else if (result.action === "deleted") summary.deleted += 1;
    else if (result.action === "failed") summary.failed += 1;
    else summary.inconclusive += 1;

    await delay(LINK_CHECK_DELAY_MS);
  }

  console.log(`[LinkCheck] Completed batch: ${JSON.stringify(summary)}`);
  return summary;
};

const checkAllActiveJobLinksImpl = async () => {
  let totalDeleted = 0;
  let totalChecked = 0;
  let batch = 0;

  while (true) {
    const summary = await checkActiveJobLinks({ limit: LINK_CHECK_BATCH_SIZE });
    totalChecked += summary.checked;
    totalDeleted += summary.deleted;
    batch += 1;

    if (summary.checked === 0) break;
  }

  const result = { batches: batch, checked: totalChecked, deleted: totalDeleted };
  console.log(`[LinkCheck] Full run: ${JSON.stringify(result)}`);
  return result;
};

export const checkAllActiveJobLinks = withCatalogInvalidation(
  "link-check",
  checkAllActiveJobLinksImpl,
);
