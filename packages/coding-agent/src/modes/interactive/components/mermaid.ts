import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { MermaidRenderingMode } from "../../../core/settings-manager.ts";
import type { Theme } from "../theme/theme.ts";

/** Preserve Mermaid source without a renderer dependency. */
export function createMermaidMarkdownTransformer(_options: {
	getMode: () => MermaidRenderingMode;
	theme?: Theme;
}): MarkdownTransformer {
	return (markdown) => markdown;
}
