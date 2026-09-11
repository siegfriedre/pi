/** Daas keeps sessions local; /export remains available. */
export async function shareSession(context: { showError: (message: string) => void }): Promise<void> {
	context.showError("Online sharing is unavailable in Daas. Use /export to save a local copy.");
}
