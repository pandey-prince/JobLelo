import { ScrapedJob } from "../../models/scrapedJob.model.js";
import { JobSource } from "../../models/jobSource.model.js";
import { DismissedJob } from "../../models/dismissedJob.model.js";
import { User } from "../../models/user.model.js";

/**
 * Replaces the Mongoose model query entry points used by the catalog and the
 * public controllers with in-memory fixtures (no MongoDB needed).
 * Returns { calls, restore }.
 */
const matches = (doc, query = {}) =>
  Object.entries(query).every(([key, expected]) => {
    if (key === "$or") return true; // not used by the cached path
    return doc[key] === expected;
  });

const chain = (rows) => {
  let data = rows;
  const api = {
    select: () => api,
    sort: () => api,
    populate: () => api,
    skip: (n) => { data = data.slice(n); return api; },
    limit: (n) => { data = data.slice(0, n); return api; },
    lean: () => api,
    then: (resolve, reject) => Promise.resolve(data).then(resolve, reject),
  };
  return api;
};

export const stubDb = ({ jobs = [], sources = [], dismissed = {}, profiles = {} } = {}) => {
  const calls = { scrapedJobFind: 0, jobSourceFind: [], dismissedFind: 0, userFind: 0 };
  const original = {
    scraped: ScrapedJob.find,
    source: JobSource.find,
    sourceById: JobSource.findById,
    sourceUpdate: JobSource.findByIdAndUpdate,
    dismissed: DismissedJob.find,
    user: User.findById,
  };

  ScrapedJob.find = (query) => {
    calls.scrapedJobFind += 1;
    return chain(jobs.filter((job) => matches(job, query)));
  };
  JobSource.find = (query) => {
    calls.jobSourceFind.push(query);
    return chain(sources.filter((source) => matches(source, query)));
  };
  JobSource.findById = async (id) => sources.find((source) => String(source._id) === String(id)) || null;
  JobSource.findByIdAndUpdate = async (id, updates) => {
    const found = sources.find((source) => String(source._id) === String(id));
    return found ? { ...found, ...updates } : null;
  };
  DismissedJob.find = (query) => {
    calls.dismissedFind += 1;
    return chain((dismissed[String(query.user)] || []).map((jobKey) => ({ jobKey })));
  };
  User.findById = (id) => {
    calls.userFind += 1;
    return chain(profiles[String(id)] ? { profile: profiles[String(id)] } : null);
  };

  return {
    calls,
    restore: () => {
      ScrapedJob.find = original.scraped;
      JobSource.find = original.source;
      JobSource.findById = original.sourceById;
      JobSource.findByIdAndUpdate = original.sourceUpdate;
      DismissedJob.find = original.dismissed;
      User.findById = original.user;
    },
  };
};

export const mockRes = () => {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(payload) { res.body = payload; return res; },
  };
  return res;
};
