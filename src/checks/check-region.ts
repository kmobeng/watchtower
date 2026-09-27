/**
 * Region label written on every check row. Single worker today, so 'local'.
 * Multi-region step: each deployed worker sets CHECK_REGION from its
 * environment instead (e.g. CHECK_REGION=eu-west-1).
 */
export const CHECK_REGION = process.env.CHECK_REGION ?? 'local';
