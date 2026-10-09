import mongoose from "mongoose";

export const silent = { warn() {}, log() {}, error() {} };
export const oid = () => new mongoose.Types.ObjectId();
export const sourceA = oid();
export const sourceB = oid();
export const hiddenSource = oid();

let seq = 0;
export const raw = (overrides = {}) => {
  seq += 1;
  return {
    _id: oid(),
    title: `Software Engineer ${seq}`,
    description: "<p>Build <b>backend</b> services with Node.js and MongoDB.</p>",
    location: "Bengaluru, India",
    jobType: "Full-time",
    salary: "Not disclosed",
    requirements: ["Node.js", "MongoDB"],
    applicationUrl: `https://careers.example.com/job/${seq}`,
    companyName: "Acme",
    companyLogo: "",
    firstSeenAt: new Date(Date.now() - seq * 60_000),
    status: "active",
    source: sourceA,
    ...overrides,
  };
};

export const fixtures = () => {
  seq = 0;
  return [
    raw({ title: "Software Engineer - React", companyName: "Acme", location: "Hyderabad, India" }),
    raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB }),
    raw({ title: "Data Engineer", companyName: "Initech", location: "Noida, India", description: "x".repeat(900) + " kubernetes-secret-word" }),
    raw({ title: "C++ Developer", companyName: "Umbrella", location: "Chennai, India" }),
    // dropped: not IT
    raw({ title: "Sales Manager", companyName: "Acme", location: "Mumbai, India", description: "Sell things." }),
    // dropped: not India
    raw({ title: "Software Engineer", companyName: "Foreign Inc", location: "Berlin, Germany" }),
    // dropped: hidden source
    raw({ title: "Software Engineer Hidden", companyName: "Ghost", location: "Pune, India", source: hiddenSource }),
    // duplicate (same company+title) -> older one dropped by dedupe
    raw({ title: "Backend Developer", companyName: "Globex", location: "Pune, India", source: sourceB, applicationUrl: "https://careers.example.com/dup" }),
  ];
};

