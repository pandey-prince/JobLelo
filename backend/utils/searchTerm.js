export const MAX_SEARCH_TERM_LENGTH = 100;

/** Escape a string so it can be used literally inside a RegExp / Mongo $regex. */
export const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Trim and bound a user-supplied search term (query-string arrays collapse to a string). */
export const sanitizeSearchTerm = (value) =>
  String(value ?? "")
    .trim()
    .slice(0, MAX_SEARCH_TERM_LENGTH);
