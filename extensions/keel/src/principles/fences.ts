import { matchesGlob, posix } from "node:path";

function normalizeFence(path: string) {
	if (
		!path ||
		posix.isAbsolute(path) ||
		/^[a-z]:/iu.test(path) ||
		/[\s\p{Cc}*?[\]{}\\]/u.test(path) ||
		path.split("/").includes("..")
	)
		return null;
	return posix.normalize(path).replace(/\/+$/u, "");
}

const fenceHelp =
	"A fence is a literal repository-relative file or directory path. Write one per line, without spaces, globs, or .. segments. Use . for the whole repository.";

export function parseFences(
	text: string,
): { paths: string[] } | { reject: string } {
	const paths: string[] = [];
	for (const line of text.split("\n")) {
		const value = line.trim();
		if (!value) continue;
		const path = normalizeFence(value);
		if (path === null)
			return {
				reject: `${fenceHelp} Invalid fence: ${JSON.stringify(value)}.`,
			};
		paths.push(path);
	}
	return paths.length ? { paths } : { reject: fenceHelp };
}

export function overlapsFence(fence: string, pattern: string): boolean {
	const path = normalizeFence(fence);
	if (path === null || !pattern) return false;
	if (path === ".") return true;
	// A glob can match the fence directly, or cover a directory above it.
	for (
		let ancestor = path;
		ancestor !== ".";
		ancestor = posix.dirname(ancestor)
	)
		if (matchesGlob(ancestor, pattern)) return true;
	// A fence can also cover the directory from which a glob descends.
	for (
		let i = pattern.lastIndexOf("/");
		i > 0;
		i = pattern.lastIndexOf("/", i - 1)
	)
		if (matchesGlob(path, pattern.slice(0, i))) return true;
	return false;
}
