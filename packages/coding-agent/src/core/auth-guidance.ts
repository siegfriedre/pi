import { join } from "node:path";
import { getAgentDir, getDocsPath } from "../config.ts";

const UNKNOWN_PROVIDER = "unknown";

export function getProviderLoginHelp(): string {
	return [
		"Set DEEPSEEK_API_KEY before starting Daas, or configure another OpenAI-compatible API key locally.",
		`Models: ${join(getAgentDir(), "models.json")}`,
		"OAuth login and online model discovery are unavailable. See:",
		`  ${join(getDocsPath(), "models.md")}`,
	].join("\n");
}

export function formatNoModelsAvailableMessage(): string {
	return `No models available. ${getProviderLoginHelp()}`;
}

export function formatNoModelSelectedMessage(): string {
	return `No model selected.\n\n${getProviderLoginHelp()}\n\nThen use /model to select a model.`;
}

export function formatNoApiKeyFoundMessage(provider: string): string {
	const providerDisplay = provider === UNKNOWN_PROVIDER ? "the selected model" : provider;
	return `No API key found for ${providerDisplay}.\n\n${getProviderLoginHelp()}`;
}
