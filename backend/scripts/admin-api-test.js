/**
 * Admin ops API test — run against local or production backend.
 * Set TEST_API_BASE (default http://localhost:8000)
 * Set TEST_ADMIN_EMAIL + TEST_ADMIN_PASSWORD for authenticated admin tests.
 */
import dotenv from "dotenv";

dotenv.config();

const API_BASE = process.env.TEST_API_BASE || "http://localhost:8000";
const ADMIN_EMAIL = process.env.TEST_ADMIN_EMAIL || process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.TEST_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD;
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
    const headers = { ...(options.headers || {}) };
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

    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    return { response, data };
  }
}

const run = async () => {
  console.log(`\n=== JobVista Admin API Test (${API_BASE}) ===\n`);
  const ts = Date.now();
  const student = new CookieClient(API_BASE);
  const admin = new CookieClient(API_BASE);

  try {
    const adminReg = await fetch(`${API_BASE}/api/v1/user/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullname: "Fake Admin",
        email: `admin${ts}@test.com`,
        password: "Test@1234",
        phoneNumber: 9876543212,
        role: "admin",
      }),
    });
    const adminRegData = await adminReg.json();
    adminReg.status === 403 && !adminRegData.success
      ? pass("POST /user/register (admin blocked)", adminRegData.message)
      : fail("POST /user/register (admin blocked)", adminRegData?.message);

    const unauthDashboard = await fetch(`${API_BASE}/api/v1/admin/dashboard`);
    unauthDashboard.status === 401 || unauthDashboard.status === 403
      ? pass("GET /admin/dashboard (unauthenticated blocked)", `HTTP ${unauthDashboard.status}`)
      : fail("GET /admin/dashboard (unauthenticated blocked)", `HTTP ${unauthDashboard.status}`);

    const studentReg = await student.request("/api/v1/user/register", {
      method: "POST",
      body: {
        fullname: "Test Student",
        email: `student-admin-test-${ts}@test.com`,
        password: "Test@1234",
        phoneNumber: 9876543210,
        role: "student",
      },
    });
    studentReg.response.ok && studentReg.data.success
      ? pass("POST /user/register (student for guard test)")
      : fail("POST /user/register (student)", studentReg.data?.message);

    const studentDashboard = await student.request("/api/v1/admin/dashboard");
    studentDashboard.response.status === 403
      ? pass("GET /admin/dashboard (student blocked)", studentDashboard.data?.message)
      : fail("GET /admin/dashboard (student blocked)", `HTTP ${studentDashboard.response.status}`);

    const studentSources = await student.request("/api/v1/scraped-jobs/sources");
    studentSources.response.status === 403
      ? pass("GET /scraped-jobs/sources (student blocked)")
      : fail("GET /scraped-jobs/sources (student blocked)", `HTTP ${studentSources.response.status}`);

    if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
      skip("Admin authenticated tests", "set TEST_ADMIN_EMAIL and TEST_ADMIN_PASSWORD");
    } else {
      const adminLogin = await admin.request("/api/v1/user/login", {
        method: "POST",
        body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
      });
      adminLogin.response.ok &&
      adminLogin.data.success &&
      adminLogin.data.user?.role === "admin"
        ? pass("POST /user/login (admin)", adminLogin.data.user.email)
        : fail("POST /user/login (admin)", adminLogin.data?.message);

      if (adminLogin.data?.user?.role === "admin") {
        const dashboard = await admin.request("/api/v1/admin/dashboard?limit=5");
        dashboard.response.ok &&
        dashboard.data.success &&
        dashboard.data.summary &&
        Array.isArray(dashboard.data.sources)
          ? pass(
              "GET /admin/dashboard",
              `${dashboard.data.summary.totalSources} sources, ${dashboard.data.sources.length} rows`,
            )
          : fail("GET /admin/dashboard", dashboard.data?.message);

        const hasCounts =
          dashboard.data?.sources?.length > 0 &&
          "activeJobsInDb" in dashboard.data.sources[0] &&
          "visibleJobsOnSite" in dashboard.data.sources[0];
        hasCounts
          ? pass("Dashboard per-source job counts present")
          : fail("Dashboard per-source job counts present");

        const sources = await admin.request("/api/v1/admin/sources");
        sources.response.ok &&
        sources.data.success &&
        Array.isArray(sources.data.sources) &&
        sources.data.sources.length > 0
          ? pass("GET /admin/sources", `${sources.data.sources.length} sources`)
          : fail("GET /admin/sources", sources.data?.message);

        const opsSources = await admin.request("/api/v1/scraped-jobs/sources");
        opsSources.response.ok && opsSources.data.success
          ? pass("GET /scraped-jobs/sources (admin)", `${opsSources.data.sources?.length || 0} sources`)
          : fail("GET /scraped-jobs/sources (admin)", opsSources.data?.message);

        const searchDash = await admin.request(
          "/api/v1/admin/dashboard?search=infosys&limit=10",
        );
        searchDash.response.ok && searchDash.data.success
          ? pass("GET /admin/dashboard search", `${searchDash.data.sources?.length || 0} matches`)
          : fail("GET /admin/dashboard search", searchDash.data?.message);

        const adminLogout = await admin.request("/api/v1/user/logout", { method: "POST" });
        adminLogout.response.ok ? pass("POST /user/logout (admin)") : fail("POST /user/logout (admin)");
      }
    }
  } catch (error) {
    fail("Admin test suite crashed", error.message);
  }

  const failed = results.filter((r) => !r.ok);
  const skipped = results.filter((r) => r.skipped);
  console.log(
    `\n=== Results: ${results.length - failed.length - skipped.length}/${results.length - skipped.length} passed` +
      (skipped.length ? ` (${skipped.length} skipped)` : "") +
      " ===\n",
  );
  process.exit(failed.length > 0 ? 1 : 0);
};

run();
