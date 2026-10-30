import type { Pagination } from "../types/api.js";

const DEFAULT_TAKE = 20;
const MAX_TAKE = 100;

// Page size from a `take` query param, clamped to 1..MAX_TAKE.
export function parseTake(raw: unknown, fallback = DEFAULT_TAKE): number {
  const take = parseInt(String(raw), 10);
  if (Number.isNaN(take)) return fallback;
  return Math.min(Math.max(take, 1), MAX_TAKE);
}

// Turns `take + 1` rows fetched for a cursor page into the page and its
// pagination. The extra row only signals that another page exists.
export function toPage<T extends { id: string }>(
  rows: T[],
  take: number,
): { data: T[]; pagination: Pagination } {
  const hasNextPage = rows.length > take;
  const data = hasNextPage ? rows.slice(0, take) : rows;
  return {
    data,
    pagination: {
      nextCursor: hasNextPage ? data[data.length - 1].id : null,
      hasNextPage,
    },
  };
}
