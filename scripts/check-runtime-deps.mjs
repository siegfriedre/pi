#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

const failures = [];

function checkSource(source, manifest) {
	const file = source.fileName;
	const declared = new Set([
		manifest.name,
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.optionalDependencies ?? {}),
		...Object.keys(manifest.peerDependencies ?? {}),
	]);

	function checkSpecifier(node) {
		if (!node || !ts.isStringLiteralLike(node)) return;
		const specifier = node.text;
		if (specifier.startsWith(".") || specifier.startsWith("/") || isBuiltin(specifier)) return;
		const name = specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
		if (declared.has(name)) return;
		const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
		failures.push(`${file}:${line + 1}: ${specifier} is not declared in ${manifest.name}'s runtime dependencies`);
	}

	function visit(node) {
		if (ts.isImportDeclaration(node)) {
			const clause = node.importClause;
			const bindings = clause?.namedBindings;
			if (
				!clause ||
				(!clause.isTypeOnly &&
					(clause.name || !bindings || !ts.isNamedImports(bindings) ||
						bindings.elements.length === 0 || bindings.elements.some((element) => !element.isTypeOnly)))
			) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (ts.isExportDeclaration(node) && !node.isTypeOnly) {
			const clause = node.exportClause;
			if (!clause || !ts.isNamedExports(clause) || clause.elements.length === 0 || clause.elements.some((element) => !element.isTypeOnly)) {
				checkSpecifier(node.moduleSpecifier);
			}
		} else if (
			ts.isCallExpression(node) &&
			(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
				(ts.isIdentifier(node.expression) && node.expression.text === "require") ||
				(ts.isPropertyAccessExpression(node.expression) && node.expression.getText(source) === "require.resolve"))
		) {
			checkSpecifier(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
}

const rootManifest = JSON.parse(readFileSync("package.json", "utf8"));
const config = ts.readConfigFile("tsconfig.daas.json", ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, "\n"));
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve("."));
if (parsed.errors.length > 0) {
	throw new Error(parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("\n"));
}
const program = ts.createProgram(parsed.fileNames, parsed.options);
for (const directory of rootManifest.workspaces) {
	const sourceDirectory = resolve(directory, "src");
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	for (const source of program.getSourceFiles()) {
		if (source.isDeclarationFile || source.fileName.endsWith(".json")) continue;
		const path = relative(sourceDirectory, resolve(source.fileName));
		if (path.startsWith("..") || isAbsolute(path)) continue;
		checkSource(source, manifest);
	}
}

if (failures.length > 0) {
	console.error("Undeclared runtime imports in public packages:");
	for (const failure of failures) console.error(`  ${failure}`);
	process.exit(1);
}
console.log("Public package runtime imports have declared dependencies.");
