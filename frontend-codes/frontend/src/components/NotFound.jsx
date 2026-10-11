import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useDispatch } from "react-redux";
import { Button } from "@/components/ui/button";
import { setSearchedQuery } from "@/redux/jobSlice";

const BriefcaseBadge = () => (
  <svg
    viewBox="0 0 32 32"
    aria-hidden="true"
    style={{ width: "clamp(72px, 14vw, 132px)", height: "auto" }}
  >
    <rect width="32" height="32" rx="8" fill="#059669" />
    <rect x="7" y="14" width="18" height="11" rx="2.5" fill="#fff" />
    <path
      d="M12 14v-2.2a4 4 0 0 1 8 0V14"
      fill="none"
      stroke="#fff"
      strokeWidth="2"
      strokeLinecap="round"
    />
    <circle cx="24" cy="8" r="4" fill="#F59E0B" />
  </svg>
);

/**
 * Shown for any URL that doesn't match a route (rendered inside MainLayout,
 * so the site header and footer are already around it).
 */
const NotFound = () => {
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const [query, setQuery] = useState("");

  // The app is a SPA, so unknown URLs still return HTTP 200 from the host.
  // Tell search engines not to index this page.
  useEffect(() => {
    const previousTitle = document.title;
    document.title = "Page not found | JobLeLo";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex";
    document.head.appendChild(robots);

    return () => {
      document.title = previousTitle;
      robots.remove();
    };
  }, []);

  const handleSearch = (event) => {
    event.preventDefault();
    dispatch(setSearchedQuery(query.trim()));
    navigate("/jobs");
  };

  const browseLatestJobs = () => {
    dispatch(setSearchedQuery(""));
  };

  return (
    <section
      aria-labelledby="not-found-title"
      className="mx-auto flex max-w-3xl flex-col items-center gap-5 px-4 py-14 text-center sm:py-20"
    >
      <div
        aria-hidden="true"
        className="flex items-center font-extrabold leading-none text-emerald-900 dark:text-emerald-200"
        style={{
          fontSize: "clamp(88px, 18vw, 168px)",
          gap: "clamp(8px, 2vw, 24px)",
        }}
      >
        4<BriefcaseBadge />4
      </div>

      <span className="rounded-full bg-brand-muted px-4 py-1.5 text-sm font-bold text-brand">
        Error 404
      </span>

      <h1
        id="not-found-title"
        className="text-3xl font-bold leading-tight sm:text-4xl"
      >
        {"This job isn't here anymore"}
      </h1>

      <p className="max-w-xl text-lg leading-relaxed text-muted-foreground">
        {
          "The page you're looking for doesn't exist or has moved. Let's get you back to fresh IT jobs from company career pages."
        }
      </p>

      <div className="flex flex-wrap items-center justify-center gap-3.5">
        <Button
          asChild
          variant="brand"
          size="lg"
          className="h-12 px-7 text-base font-bold"
        >
          <Link to="/jobs" onClick={browseLatestJobs}>
            Browse latest jobs
          </Link>
        </Button>
        <Button
          asChild
          variant="outline"
          size="lg"
          className="h-12 px-7 text-base font-bold"
        >
          <Link to="/">Back to home</Link>
        </Button>
      </div>

      <form
        role="search"
        onSubmit={handleSearch}
        className="mt-2 flex flex-wrap items-center justify-center gap-2.5"
      >
        <label
          htmlFor="not-found-search"
          className="text-sm text-muted-foreground"
        >
          Or search by role:
        </label>
        <input
          id="not-found-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="React developer, DevOps, Data engineer"
          className="h-11 w-[min(340px,80vw)] rounded-[10px] border border-input bg-background px-3.5 text-[15px] text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        />
        <Button type="submit" className="h-11 px-5 text-[15px] font-bold">
          Search
        </Button>
      </form>

      <p className="mt-6 text-sm text-muted-foreground">
        Think this is a mistake? Write to{" "}
        <a
          href="mailto:founder@joblelo.online"
          className="font-semibold text-brand underline-offset-4 hover:underline"
        >
          founder@joblelo.online
        </a>
      </p>
    </section>
  );
};

export default NotFound;
