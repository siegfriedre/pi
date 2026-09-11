/**
 * Rebrand the agent's self-identity from "pi" to "daas" in the system prompt.
 *
 * This does exact-string replacement on the default prompt only, so prompt
 * quality and behavior are unchanged. File paths, AGENTS.md content, and
 * skills are left untouched.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const IDENTITY_REPLACEMENTS: Array<[string, string]> = [
	["operating inside pi, a coding agent harness", "operating inside daas, a coding agent harness"],
	[
		"Pi documentation (read only when the user asks about pi itself,",
		"Daas documentation (read only when the user asks about daas itself,",
	],
	["When working on pi topics,", "When working on daas topics,"],
	["When reading pi docs or examples", "When reading daas docs or examples"],
	["pi packages (docs/packages.md)", "daas packages (docs/packages.md)"],
	["Always read pi .md files completely", "Always read daas .md files completely"],
];

/** Only modify the known built-in prompt prefix; preserve appended/project prompts verbatim. */
export function rebrandSystemPrompt(prompt: string): string {
	const start = "You are an expert coding assistant operating inside pi, a coding agent harness.";
	const end =
		"- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
	if (!prompt.startsWith(start)) return prompt;
	const endIndex = prompt.indexOf(end);
	if (endIndex < 0) return prompt;
	const boundary = endIndex + end.length;
	let prefix = prompt.slice(0, boundary);
	for (const [from, to] of IDENTITY_REPLACEMENTS) prefix = prefix.replaceAll(from, to);
	return prefix + prompt.slice(boundary);
}

export default function daasRebrand(pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event) => {
		return { systemPrompt: rebrandSystemPrompt(event.systemPrompt) };
	});
}
