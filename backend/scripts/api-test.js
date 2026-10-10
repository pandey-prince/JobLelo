import dotenv from "dotenv";
import mongoose from "mongoose";
import * as XLSX from "xlsx";
import { parseCareerSourcesSpreadsheet } from "../utils/parseCareerSourcesSpreadsheet.js";
import { isItJob } from "../utils/itJobFilter.js";
import { isIndiaJob } from "../utils/indiaJobFilter.js";
import { User } from "../models/user.model.js";

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || "http://localhost:8000";
const results = [];

const pass = (name, detail = "") => {
  results.push({ name, ok: true, detail });
  console.log(`✓ ${name}${detail ? ` — ${detail}` : ""}`);
};

const fail = (name, detail = "") => {
  results.push({ name, ok: false, detail });
  console.error(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
};

const skip = (name, detail = "") => {
  results.push({ name, ok: true, skipped: true, detail });
  console.log(`⊘ ${name} (skipped${detail ? ` — ${detail}` : ""})`);
};

class CookieClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.cookie = "";
  }

  async request(path, options = {}) {
    const headers = {
      ...(options.headers || {}),
    };
    if (this.cookie) headers.Cookie = this.cookie;
    if (options.body && !(options.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      ...options,
      headers,
      body:
        options.body && !(options.body instanceof FormData)
          ? JSON.stringify(options.body)
          : options.body,
    });

    // Apply every Set-Cookie in order like a browser: the last one wins and an
    // empty value clears the cookie (login sends "clear old token" then "new token").
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [response.headers.get("set-cookie")].filter(Boolean);
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const value = pair.slice(pair.indexOf("=") + 1);
      this.cookie = value ? pair : "";
    }

    let data = null;
    const text = await response.text();
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    return { response, data };
  }
}

const run = async () => {
  console.log("\n=== JobLeLo Full API Test Suite ===\n");
  const ts = Date.now();
  const studentEmail = `student${ts}@test.com`;
  const student = new CookieClient(API_BASE);

  try {
    const health = await fetch(`${API_BASE}/home`);
    const healthData = await health.json();
    health.ok && healthData.success
      ? pass("Health check /home")
      : fail("Health check /home", `Status ${health.status}`);

    const jobsPublic = await fetch(`${API_BASE}/api/v1/job/get`);
    const jobsData = await jobsPublic.json();
    jobsPublic.ok && jobsData.success
      ? pass("GET /api/v1/job/get", `${jobsData.jobs?.length || 0} jobs`)
      : fail("GET /api/v1/job/get");

    const sourcesPublic = await fetch(`${API_BASE}/api/v1/career-sources/`);
    const sourcesData = await sourcesPublic.json();
    sourcesPublic.ok && sourcesData.success
      ? pass("GET /api/v1/career-sources", `${sourcesData.sources?.length || 0} companies`)
      : fail("GET /api/v1/career-sources");

    const studentReg = await student.request("/api/v1/user/register", {
      method: "POST",
      body: {
        fullname: "Test Student",
        email: studentEmail,
        password: "Test@1234",
        phoneNumber: 9876543210,
        role: "student",
      },
    });
    studentReg.response.ok &&
    studentReg.data.success &&
    studentReg.data.needsVerification
      ? pass("POST /user/register (student)", "needsVerification")
      : fail("POST /user/register (student)", studentReg.data?.message);

    const badVerify = await student.request("/api/v1/user/verify-email", {
      method: "POST",
      body: { email: studentEmail, otp: "000000" },
    });
    badVerify.response.status === 400
      ? pass("POST /user/verify-email (invalid otp)")
      : fail("POST /user/verify-email (invalid otp)", badVerify.data?.message);

    const googleBad = await fetch(`${API_BASE}/api/v1/user/google`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: "invalid-token" }),
    });
    googleBad.status === 401 || googleBad.status === 503
      ? pass("POST /user/google (invalid token)", `HTTP ${googleBad.status}`)
      : fail("POST /user/google (invalid token)", `HTTP ${googleBad.status}`);

    if (process.env.MONGO_URI) {
      await mongoose.connect(process.env.MONGO_URI);
      await User.updateOne({ email: studentEmail }, { $set: { emailVerified: true } });
      await mongoose.disconnect();
      const studentLogin = await student.request("/api/v1/user/login", {
        method: "POST",
        body: { email: studentEmail, password: "Test@1234" },
      });
      studentLogin.response.ok && studentLogin.data.success
        ? pass("POST /user/login (after verify)", studentEmail)
        : fail("POST /user/login (after verify)", studentLogin.data?.message);
    } else {
      skip("POST /user/login (after verify)", "set MONGO_URI to mark test user verified");
    }

    const detectRes = await student.request("/api/v1/career-sources/detect", {
      method: "POST",
      body: { url: "https://boards.greenhouse.io/stripe" },
    });
    detectRes.response.ok && detectRes.data.scraperType === "greenhouse"
      ? pass("POST /career-sources/detect", detectRes.data.scraperType)
      : fail("POST /career-sources/detect", detectRes.data?.message);

    const me = await student.request("/api/v1/user/me");
    me.response.ok && me.data.success && me.data.user?.email
      ? pass("GET /user/me", me.data.user.email)
      : fail("GET /user/me", me.data?.message);

    const recommendedAuth = await student.request("/api/v1/job/recommended?limit=5");
    recommendedAuth.response.ok &&
    recommendedAuth.data.success &&
    Array.isArray(recommendedAuth.data.jobs)
      ? pass(
          "GET /job/recommended (auth)",
          recommendedAuth.data.personalized ? "personalized" : "generic",
        )
      : fail("GET /job/recommended (auth)", recommendedAuth.data?.message);

    const publicStats = await fetch(`${API_BASE}/api/v1/stats/public`);
    const statsData = await publicStats.json();
    publicStats.ok && statsData.success && typeof statsData.stats?.totalJobs === "number"
      ? pass("GET /stats/public", `${statsData.stats.totalJobs} jobs`)
      : fail("GET /stats/public", statsData?.message);

    publicStats.ok &&
    statsData.success &&
    typeof statsData.stats?.sourcesSyncedSuccessfully === "number" &&
    typeof statsData.stats?.companiesWithJobs === "number" &&
    ("lastSyncAt" in (statsData.stats || {}))
      ? pass(
          "GET /stats/public sync fields",
          `${statsData.stats.sourcesSyncedSuccessfully} synced, ${statsData.stats.companiesWithJobs} with jobs`,
        )
      : fail("GET /stats/public sync fields");

    publicStats.ok &&
    statsData.success &&
    (statsData.stats?.lastSyncAt === null || typeof statsData.stats?.lastSyncAt === "string")
      ? pass("GET /stats/public lastSyncAt", statsData.stats.lastSyncAt || "none yet")
      : fail("GET /stats/public lastSyncAt");

    const jobsNewest = await fetch(`${API_BASE}/api/v1/job/get?sortBy=newest&limit=5`);
    const jobsNewestData = await jobsNewest.json();
    jobsNewest.ok && jobsNewestData.success && Array.isArray(jobsNewestData.jobs)
      ? pass("GET /job/get sortBy=newest", `${jobsNewestData.jobs.length} jobs`)
      : fail("GET /job/get sortBy=newest");

    const jobsSorted = await fetch(`${API_BASE}/api/v1/job/get?sortBy=company&limit=5`);
    const jobsSortedData = await jobsSorted.json();
    jobsSorted.ok && jobsSortedData.success && Array.isArray(jobsSortedData.jobs)
      ? pass("GET /job/get sortBy=company", `${jobsSortedData.jobs.length} jobs`)
      : fail("GET /job/get sortBy=company");

    const sampleCompany = sourcesData.sources?.[0]?.companyName;
    if (sampleCompany) {
      const jobsByCompany = await fetch(
        `${API_BASE}/api/v1/job/get?companies=${encodeURIComponent(sampleCompany)}&limit=5`,
      );
      const jobsByCompanyData = await jobsByCompany.json();
      jobsByCompany.ok && jobsByCompanyData.success
        ? pass("GET /job/get companies filter", sampleCompany)
        : fail("GET /job/get companies filter");
    } else {
      skip("GET /job/get companies filter", "no public sources");
    }

    const recommendedGuest = await fetch(`${API_BASE}/api/v1/job/recommended?limit=5`);
    const recommendedGuestData = await recommendedGuest.json();
    recommendedGuest.ok &&
    recommendedGuestData.success &&
    Array.isArray(recommendedGuestData.jobs)
      ? pass("GET /job/recommended (guest)", `${recommendedGuestData.jobs.length} jobs`)
      : fail("GET /job/recommended (guest)");

    if (sampleCompany) {
      const { slugifyCompanyName } = await import("../utils/companySlug.js");
      const companySlug = slugifyCompanyName(sampleCompany);
      const companyJobs = await fetch(
        `${API_BASE}/api/v1/career-sources/${encodeURIComponent(companySlug)}/jobs?limit=5`,
      );
      const companyJobsData = await companyJobs.json();
      companyJobs.ok && companyJobsData.success && companyJobsData.source?.companyName
        ? pass("GET /career-sources/:slug/jobs", companyJobsData.source.companyName)
        : fail("GET /career-sources/:slug/jobs", companyJobsData?.message);
    } else {
      skip("GET /career-sources/:slug/jobs", "no public sources");
    }

    const recruiterReg = await fetch(`${API_BASE}/api/v1/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullname: "Test Recruiter",
        email: `recruiter${ts}@test.com`,
        password: "Test@1234",
        phoneNumber: 9876543211,
        role: "recruiter",
      }),
    });
    const recruiterRegData = await recruiterReg.json();
    recruiterReg.status === 403 && !recruiterRegData.success
      ? pass("POST /user/register (recruiter blocked)", recruiterRegData.message)
      : fail("POST /user/register (recruiter blocked)", recruiterRegData?.message);

    const submitCareer = await student.request("/api/v1/career-sources/submit", {
      method: "POST",
      body: {
        url: "https://boards.greenhouse.io/postman",
        companyName: "Postman",
        addToWatchlist: true,
      },
    });
    submitCareer.response.ok && submitCareer.data.success
      ? pass("POST /career-sources/submit", submitCareer.data.source?.companyName)
      : fail("POST /career-sources/submit", submitCareer.data?.message);

    const watchlist = await student.request("/api/v1/career-sources/lists?type=watchlist");
    watchlist.response.ok && watchlist.data.lists?.length > 0
      ? pass("GET /career-sources/lists (watchlist)", `${watchlist.data.lists.length} entries`)
      : fail("GET /career-sources/lists (watchlist)");

    const manualAdd = await student.request("/api/v1/career-sources/lists", {
      method: "POST",
      body: {
        listType: "watchlist",
        companyName: "Dream Company",
        notes: "Future goal",
      },
    });
    manualAdd.response.ok && manualAdd.data.success
      ? pass("POST /career-sources/lists (watchlist manual)")
      : fail("POST /career-sources/lists (watchlist manual)", manualAdd.data?.message);

    const watchlistJobs = await student.request(
      "/api/v1/career-sources/lists/jobs?type=watchlist"
    );
    watchlistJobs.response.ok
      ? pass("GET /career-sources/lists/jobs", `${watchlistJobs.data.jobs?.length || 0} jobs`)
      : fail("GET /career-sources/lists/jobs");

    const scrapedList = await fetch(`${API_BASE}/api/v1/scraped-jobs`);
    const scrapedData = await scrapedList.json();
    scrapedList.ok && scrapedData.success
      ? pass("GET /scraped-jobs", `${scrapedData.jobs?.length || 0} jobs`)
      : fail("GET /scraped-jobs");

    skip("GET /scraped-jobs/sources (recruiter)", "use admin-api-test.js");
    skip("POST /career-sources/import/excel (recruiter)", "use admin-api-test.js");

    const workbookData = [
      ["companyName", "careerUrl"],
      [`ExcelCo${ts}`, "https://jobs.lever.co/cred"],
    ];
    const ws = XLSX.utils.aoa_to_sheet(workbookData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Companies");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const parsed = parseCareerSourcesSpreadsheet(buffer);
    parsed.length === 1
      ? pass("Excel parser unit test")
      : fail("Excel parser unit test");

    isItJob({ title: "Software Engineer" }) && !isItJob({ title: "Marketing Manager" })
      ? pass("IT job filter")
      : fail("IT job filter");

    isIndiaJob({ location: "Bangalore, India" }) &&
    isIndiaJob({ location: "Remote - India" }) &&
    isIndiaJob({ location: "Noida and 1 more" }) &&
    isIndiaJob({
      title: "Developer Bangalore, IN",
      location: "Not specified",
    }) &&
    !isIndiaJob({ location: "" }) &&
    !isIndiaJob({ location: "Not specified" }) &&
    !isIndiaJob({ location: "Remote" }) &&
    !isIndiaJob({ location: "and 1 more" }) &&
    !isIndiaJob({ location: "+2 more" }) &&
    !isIndiaJob({ location: "San Francisco, USA" }) &&
    !isIndiaJob({ location: "London, UK" }) &&
    !isIndiaJob({ location: "Warsaw, Poland" })
      ? pass("India job filter")
      : fail("India job filter");

    const jobsList = await fetch(`${API_BASE}/api/v1/job/get`);
    const jobsListData = await jobsList.json();
    const sampleJob = jobsListData.jobs?.[0];

    if (sampleJob?._id) {
      const saveJob = await student.request("/api/v1/saved-jobs/", {
        method: "POST",
        body: { jobKey: sampleJob._id, ...sampleJob },
      });
      saveJob.response.ok && saveJob.data.success
        ? pass("POST /saved-jobs", sampleJob._id)
        : fail("POST /saved-jobs", saveJob.data?.message);

      const savedList = await student.request("/api/v1/saved-jobs/");
      savedList.response.ok && savedList.data.savedJobs?.length > 0
        ? pass("GET /saved-jobs")
        : fail("GET /saved-jobs");

      const createAlert = await student.request("/api/v1/alerts/", {
        method: "POST",
        body: {
          name: "Test Alert",
          keyword: "software",
          location: "Remote",
        },
      });
      createAlert.response.ok && createAlert.data.success
        ? pass("POST /alerts", createAlert.data.alert?.name)
        : fail("POST /alerts", createAlert.data?.message);

      const alertsList = await student.request("/api/v1/alerts/");
      alertsList.response.ok && alertsList.data.alerts?.length > 0
        ? pass("GET /alerts")
        : fail("GET /alerts");

      const trackApp = await student.request("/api/v1/tracked-applications/", {
        method: "POST",
        body: {
          jobKey: sampleJob._id,
          title: sampleJob.title,
          companyName: sampleJob.company?.name,
        },
      });
      trackApp.response.ok && trackApp.data.success
        ? pass("POST /tracked-applications")
        : fail("POST /tracked-applications", trackApp.data?.message);

      const trackerList = await student.request("/api/v1/tracked-applications/");
      trackerList.response.ok && trackerList.data.applications?.length > 0
        ? pass("GET /tracked-applications")
        : fail("GET /tracked-applications");

      const matchScore = await student.request("/api/v1/job/match-score", {
        method: "POST",
        body: { jobKey: sampleJob._id },
      });
      matchScore.response.ok && typeof matchScore.data.match?.score === "number"
        ? pass("POST /job/match-score", `${matchScore.data.match.score}%`)
        : fail("POST /job/match-score", matchScore.data?.message);
    } else {
      fail("Job seeker feature tests", "No sample job available");
    }

    const logout = await student.request("/api/v1/user/logout", { method: "POST" });
    logout.response.ok ? pass("POST /user/logout") : fail("POST /user/logout");
  } catch (error) {
    fail("Test suite crashed", error.message);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Results: ${results.length - failed.length}/${results.length} passed ===\n`);
  process.exit(failed.length > 0 ? 1 : 0);
};

run();
