import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { rebrandSystemPrompt } from "../.config/agent/extensions/daas-reband.ts";
import { APP_NAME, getAgentDir, getRepositoryAgentDir } from "../packages/coding-agent/src/config.ts";
import { AuthStorage } from "../packages/coding-agent/src/core/auth-storage.ts";
import { loadExtensions } from "../packages/coding-agent/src/core/extensions/loader.ts";
import { ModelRuntime } from "../packages/coding-agent/src/core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../packages/coding-agent/src/core/models-store.ts";
import { buildSystemPrompt } from "../packages/coding-agent/src/core/system-prompt.ts";
import { fetchWithRetry } from "../packages/coding-agent/src/utils/management-http.ts";
import { getLatestPiRelease } from "../packages/coding-agent/src/utils/version-check.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const modelsPath = join(root, ".config/agent/models.json");

function setEnv(t: TestContext, name: string, value: string): void {
	const previous = process.env[name];
	process.env[name] = value;
	t.after(() => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	});
}

test("portable configuration follows the installation, with an explicit override", (t) => {
	setEnv(t, "DAAS_CODING_AGENT_DIR", "");
	assert.equal(APP_NAME, "daas");
	assert.equal(getAgentDir(), join(root, ".config/agent"));
	const temporary = mkdtempSync(join(tmpdir(), "daas-config-"));
	t.after(() => rmSync(temporary, { recursive: true, force: true }));
	const packageDir = join(temporary, "packages/coding-agent");
	mkdirSync(packageDir, { recursive: true });
	writeFileSync(join(packageDir, "package.json"), "{}");
	assert.equal(getRepositoryAgentDir(packageDir), undefined);
	mkdirSync(join(temporary, ".config"));
	assert.equal(getRepositoryAgentDir(packageDir), join(temporary, ".config/agent"));
	process.env.DAAS_CODING_AGENT_DIR = temporary;
	assert.equal(getAgentDir(), temporary);
});

test("branding preserves appended instructions, context, custom prompts and file paths", () => {
	const instructions = "When working on pi topics, operating inside pi, a coding agent harness";
	const original = buildSystemPrompt({
		cwd: root,
		appendSystemPrompt: instructions,
		contextFiles: [{ path: "/project/pi/AGENTS.md", content: instructions }],
	});
	const branded = rebrandSystemPrompt(original);
	assert.match(branded, /^You are an expert coding assistant operating inside daas,/);
	assert.ok(branded.includes(`/project/pi/AGENTS.md`));
	assert.equal(
		branded.slice(branded.indexOf(`\n\n${instructions}`)),
		original.slice(original.indexOf(`\n\n${instructions}`)),
	);
	assert.equal(rebrandSystemPrompt(branded), branded);
	const custom = buildSystemPrompt({ cwd: root, customPrompt: instructions });
	assert.equal(rebrandSystemPrompt(custom), custom);
});

test("the supplied TypeScript extension loads through the production loader", async () => {
	const result = await loadExtensions([join(root, ".config/agent/extensions/daas-reband.ts")], root);
	assert.deepEqual(result.errors, []);
	assert.equal(result.extensions.length, 1);
	assert.equal(result.extensions[0].handlers.get("before_agent_start")?.length, 1);
});

test("catalog refresh and management endpoints never fetch; missing keys remain unavailable", async (t) => {
	setEnv(t, "DEEPSEEK_API_KEY", "");
	const fetchSpy = t.mock.method(globalThis, "fetch", async () => {
		throw new Error("Unexpected network request");
	});
	const runtime = await ModelRuntime.create({
		modelsPath,
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryCodingAgentModelsStore(),
		allowModelNetwork: true,
	});
	assert.equal(runtime.getError(), undefined);
	assert.equal(runtime.getModels().length, 1);
	assert.equal((await runtime.getAvailable()).length, 0);
	await runtime.refresh({ allowNetwork: true });
	assert.equal(await getLatestPiRelease("0.0.0"), undefined);
	await assert.rejects(fetchWithRetry("https://example.invalid"), /disables online management/);
	assert.equal(fetchSpy.mock.callCount(), 0);
});

test("DeepSeek resolves the environment key and streams fragmented tool calls and tool results", async (t) => {
	setEnv(t, "DEEPSEEK_API_KEY", "local-test-key");
	const runtime = await ModelRuntime.create({
		modelsPath,
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryCodingAgentModelsStore(),
	});
	assert.equal(runtime.getError(), undefined);
	const [model] = await runtime.getAvailable();
	assert.ok(model);
	assert.equal(model.id, "deepseek-flash");
	const requests: Record<string, unknown>[] = [];
	const fetchMock: typeof fetch = async (input, init) => {
		assert.equal(String(input), "https://api.deepseek.com/chat/completions");
		assert.equal(new Headers(init?.headers).get("authorization"), "Bearer local-test-key");
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		requests.push(body);
		assert.equal(body.model, "deepseek-flash");
		assert.deepEqual(body.thinking, { type: "enabled" });
		assert.equal(body.reasoning_effort, "high");
		const deltas =
			requests.length === 1
				? [
						{ delta: { role: "assistant", reasoning_content: "Read the requested file." }, finish_reason: null },
						{
							delta: {
								tool_calls: [
									{
										index: 0,
										id: "call_1",
										type: "function",
										function: { name: "read", arguments: '{"path":' },
									},
								],
							},
							finish_reason: null,
						},
						{
							delta: { tool_calls: [{ index: 0, function: { arguments: '"README.md"}' } }] },
							finish_reason: "tool_calls",
						},
					]
				: [{ delta: { content: "File received." }, finish_reason: "stop" }];
		const data = `${deltas.map((choice) => `data: ${JSON.stringify({ id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: model.id, choices: [{ index: 0, ...choice }] })}\n\n`).join("")}data: [DONE]\n\n`;
		return new Response(data, { headers: { "content-type": "text/event-stream" } });
	};
	const user = { role: "user" as const, content: "Read README.md", timestamp: 1 };
	const tools = [{ name: "read", description: "Read a local file", parameters: Type.Object({ path: Type.String() }) }];
	const assistant = await runtime.completeSimple(
		model,
		{ messages: [user], tools },
		{ fetch: fetchMock, reasoning: "high" },
	);
	assert.equal(assistant.stopReason, "toolUse", assistant.errorMessage);
	const call = assistant.content.find((block) => block.type === "toolCall");
	assert.ok(call && call.type === "toolCall");
	assert.deepEqual(call.arguments, { path: "README.md" });
	const final = await runtime.completeSimple(
		model,
		{
			messages: [
				user,
				assistant,
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "read",
					content: [{ type: "text", text: "# Daas" }],
					isError: false,
					timestamp: 2,
				},
			],
			tools,
		},
		{ fetch: fetchMock, reasoning: "high" },
	);
	assert.equal(final.stopReason, "stop", final.errorMessage);
	assert.ok(final.content.some((block) => block.type === "text" && block.text === "File received."));
	const replay = requests[1].messages as Array<Record<string, unknown>>;
	assert.ok(replay.some((message) => message.role === "tool"));
	assert.ok(
		replay.some(
			(message) => message.role === "assistant" && message.reasoning_content === "Read the requested file.",
		),
	);
	assert.equal(requests.length, 2);
});

test("CLI starts outside the repository and discovers the configured model", () => {
	const output = execFileSync(
		process.execPath,
		[
			"--import",
			pathToFileURL(join(root, "node_modules/tsx/dist/loader.mjs")).href,
			join(root, "packages/coding-agent/src/cli.ts"),
			"--list-models",
		],
		{
			cwd: tmpdir(),
			encoding: "utf8",
			env: {
				...process.env,
				DAAS_CODING_AGENT_DIR: "",
				TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
				DEEPSEEK_API_KEY: "local-test-key",
			},
		},
	);
	assert.match(output, /deepseek-flash/);
});
