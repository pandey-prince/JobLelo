/**
 * Seed a LOCAL database with realistic catalog data (JobSource + ScrapedJob)
 * so you can try the app and the cache without running any scrapers.
 *
 *   npm run seed:catalog                       # 120 companies, 1500 jobs
 *   node scripts/seed-local-catalog.js --jobs=5000 --companies=150
 *   node scripts/seed-local-catalog.js --reset # only remove previously seeded data
 *
 * Safety:
 *  - Refuses to run unless MONGO_URI points at localhost (override: --force).
 *  - Only touches documents it created (sources on https://seed.example/*,
 *    jobs whose externalId starts with "seed-"). Safe to re-run.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { JobSource } from "../models/jobSource.model.js";
import { ScrapedJob } from "../models/scrapedJob.model.js";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value === undefined ? true : value];
  }),
);

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/jobvista-local";
const JOBS = Math.max(1, Number(args.jobs || 1500));
const COMPANIES = Math.max(5, Number(args.companies || 120));

const isLocal = /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(MONGO_URI);
if (!isLocal && !args.force) {
  console.error(
    "Refusing to seed a non-local database. MONGO_URI does not point at localhost.\n" +
      "Use a local MongoDB (see README), or pass --force if you really mean it.",
  );
  process.exit(1);
}

// Deterministic pseudo-random so every run produces the same dataset.
let state = 123456789;
const rand = () => {
  state = (state * 1664525 + 1013904223) % 4294967296;
  return state / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];

const COMPANY_NAMES = [
  "Acme", "Globex", "Initech", "Umbrella", "Hooli", "Stark Systems", "Wayne Tech", "Wonka Labs",
  "Cyberdyne", "Soylent", "Tyrell", "Aperture", "Black Mesa", "Massive Dynamic", "Vandelay",
  "Pied Piper", "Dunder Mifflin", "Gringotts", "Oscorp", "Nakatomi",
];
const SUFFIXES = ["Technologies", "Software", "Labs", "Cloud", "Systems", "Digital", "AI", "Networks"];

const IT_ROLES = [
  "Software Engineer", "Senior Software Engineer", "Backend Developer", "Frontend Developer",
  "Full Stack Developer", "DevOps Engineer", "Data Engineer", "Machine Learning Engineer",
  "QA Engineer", "Site Reliability Engineer", "Cloud Engineer", "Mobile Developer",
  "Platform Engineer", "Security Engineer", "Solutions Architect",
];
const NON_IT_ROLES = ["Sales Manager", "HR Executive", "Accountant", "Marketing Lead", "Office Administrator"];
const STACKS = [
  ["Node.js", "React", "MongoDB"], ["Java", "Spring Boot", "Kafka"], ["Python", "Django", "PostgreSQL"],
  ["Go", "Kubernetes", "AWS"], ["TypeScript", "Next.js", "GraphQL"], ["Python", "PyTorch", "Spark"],
  [".NET", "C#", "Azure"], ["React Native", "Kotlin", "Swift"],
];
const INDIA = [
  "Bengaluru, India", "Hyderabad, India", "Pune, India", "Chennai, India", "Noida, India",
  "Gurugram, India", "Mumbai, India", "Remote, India", "Kolkata, India", "Ahmedabad, India",
];
const ABROAD = ["Berlin, Germany", "Austin, USA", "London, UK", "Toronto, Canada"];
const EXPERIENCE = ["0", "0-2 years", "2-4 years", "3-5 years", "5+ years"];

const description = (role, company, stack) =>
  `<p><strong>${company}</strong> is hiring a <b>${role}</b> to join our engineering team.</p>` +
  `<h3>What you'll do</h3><ul><li>Design, build and ship services using ${stack.join(", ")}.</li>` +
  `<li>Collaborate with product and design on roadmap and delivery.</li>` +
  `<li>Write clean, tested code and participate in code reviews.</li>` +
  `<li>Own features end to end, from design to production monitoring.</li></ul>` +
  `<h3>What we're looking for</h3><ul><li>Strong computer science fundamentals.</li>` +
  `<li>Hands-on experience with ${stack[0]} and ${stack[1]}.</li>` +
  `<li>Good communication and a bias for action.</li></ul>` +
  `<p>${"We offer competitive compensation, flexible work and a learning budget. ".repeat(4)}</p>`;

const reset = async () => {
  const sources = await JobSource.find({ url: /^https:\/\/seed\.example\// }).select("_id").lean();
  const ids = sources.map((s) => s._id);
  const jobs = await ScrapedJob.deleteMany({ $or: [{ externalId: /^seed-/ }, { source: { $in: ids } }] });
  const removed = await JobSource.deleteMany({ _id: { $in: ids } });
  console.log(`Removed ${jobs.deletedCount} seeded jobs and ${removed.deletedCount} seeded sources`);
};

const run = async () => {
  await mongoose.connect(MONGO_URI);
  console.log(`Connected: ${MONGO_URI.replace(/\/\/[^@]*@/, "//***@")}`);
  await reset();
  if (args.reset) return;

  const now = Date.now();
  const sourceDocs = [];
  for (let i = 0; i < COMPANIES; i += 1) {
    const base = COMPANY_NAMES[i % COMPANY_NAMES.length];
    const companyName = `${base} ${SUFFIXES[Math.floor(i / COMPANY_NAMES.length) % SUFFIXES.length]}${i >= COMPANY_NAMES.length * SUFFIXES.length ? ` ${i}` : ""}`;
    const broken = i % 40 === 39; // a few boards that 404 -> hidden from the public feed
    sourceDocs.push({
      name: companyName,
      companyName,
      url: `https://seed.example/${i}`,
      scraperType: "greenhouse",
      isActive: true,
      isPublic: true,
      lastScrapedAt: new Date(now - Math.floor(rand() * 6) * 3600_000),
      lastScrapeStatus: broken ? "error" : "success",
      lastScrapeError: broken ? "404 Not Found: board does not exist" : "",
    });
  }
  const sources = await JobSource.insertMany(sourceDocs);
  console.log(`Inserted ${sources.length} sources`);

  const jobDocs = [];
  for (let i = 0; i < JOBS; i += 1) {
    const source = sources[i % sources.length];
    const bucket = rand();
    const isNonIt = bucket < 0.06;
    const isAbroad = bucket >= 0.06 && bucket < 0.12;
    const stack = pick(STACKS);
    const role = isNonIt ? pick(NON_IT_ROLES) : pick(IT_ROLES);
    const title = `${role} ${stack[0]}${i % 7 === 0 ? "" : ` #${i}`}`;
    jobDocs.push({
      source: source._id,
      externalId: `seed-${i}`,
      title,
      description: isNonIt ? "<p>Manage day to day operations and client relationships.</p>" : description(role, source.companyName, stack),
      location: isAbroad ? pick(ABROAD) : pick(INDIA),
      jobType: pick(["Full-time", "Full-time", "Contract", "Internship"]),
      salary: pick(["Not disclosed", "12-20 LPA", "20-35 LPA"]),
      experienceLevel: pick(EXPERIENCE),
      requirements: stack,
      applicationUrl: `https://seed.example/${source.url.split("/").pop()}/apply/${i}`,
      companyName: source.companyName,
      status: "active",
      firstSeenAt: new Date(now - Math.floor(rand() * 20 * 24) * 3600_000),
      lastSeenAt: new Date(),
    });
  }

  for (let i = 0; i < jobDocs.length; i += 500) {
    await ScrapedJob.insertMany(jobDocs.slice(i, i + 500), { ordered: false });
  }
  console.log(`Inserted ${jobDocs.length} jobs (some are non-IT / non-India / on broken boards on purpose,`);
  console.log("so the public catalog shows fewer — that is the filters working).");
};

run()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
