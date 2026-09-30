import { AppError } from './errors.ts';

export interface PageParams {
  limit: number;
  offset: number;
}

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 200;

/** Parse and clamp paging query params. */
export function parsePage(query: URLSearchParams): PageParams {
  const limitRaw = query.get('limit');
  const offsetRaw = query.get('offset');
  let limit = DEFAULT_PAGE_SIZE;
  let offset = 0;
  if (limitRaw !== null) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit < 1)
      throw new AppError('VALIDATION', 'limit must be a positive integer');
    limit = Math.min(limit, MAX_PAGE_SIZE);
  }
  if (offsetRaw !== null) {
    offset = Number(offsetRaw);
    if (!Number.isInteger(offset) || offset < 0)
      throw new AppError('VALIDATION', 'offset must be a non-negative integer');
  }
  return { limit, offset };
}

export function pageEnvelope<T>(path: string, params: PageParams, total: number, items: T[]) {
  return {
    data: items,
    paging: {
      total,
      limit: params.limit,
      offset: params.offset,
      hasMore: params.offset + items.length < total,
      next:
        params.offset + items.length < total
          ? `${path}?limit=${params.limit}&offset=${params.offset + items.length}`
          : null,
    },
  };
}
