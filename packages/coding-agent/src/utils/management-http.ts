export interface FetchRetryOptions {
	maxRetries?: number;
	retryOnStatus?: boolean;
	timeoutMs?: number;
	attemptTimeoutMs?: number;
}
/** Management HTTP is intentionally unavailable; model transports do not use this helper. */
export async function fetchWithRetry(
	_input: Parameters<typeof fetch>[0],
	_init?: RequestInit,
	_options?: FetchRetryOptions,
): Promise<Response> {
	throw new Error("Daas disables online management requests. Configure models locally in models.json.");
}
