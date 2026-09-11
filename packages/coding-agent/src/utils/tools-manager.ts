import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getBinDir } from "../config.ts";

export interface ToolStatus {
	type: "info" | "warning";
	message: string;
}
/** Use provisioned binaries or PATH; never download executable code. */
export function getToolPath(tool: "fd" | "rg"): string | null {
	const localPath = join(getBinDir(), `${tool}${process.platform === "win32" ? ".exe" : ""}`);
	if (existsSync(localPath)) return localPath;
	for (const command of tool === "fd" ? ["fd", "fdfind"] : ["rg"]) {
		const result = spawnSync(command, ["--version"], { stdio: "pipe" });
		if (!result.error && result.status === 0) return command;
	}
	return null;
}
export async function ensureTool(
	tool: "fd" | "rg",
	onStatus?: (status: ToolStatus) => void,
): Promise<string | undefined> {
	const path = getToolPath(tool);
	if (path) return path;
	onStatus?.({ type: "warning", message: `${tool} is unavailable. Place it in ${getBinDir()} or PATH.` });
	return undefined;
}
