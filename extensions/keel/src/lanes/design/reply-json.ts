export function replyJson(answer: string): unknown {
	const fenced =
		/^ {0,3}(```+|~~~+)[^\r\n]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?$/m.exec(
			answer,
		);
	try {
		if (fenced) return JSON.parse(fenced[2]!);
		const start = answer.indexOf("{");
		if (start < 0) return null;
		const body = answer.slice(start);
		let depth = 0;
		for (const token of body.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}]/g)) {
			if (token[0] === "{") depth++;
			if (token[0] === "}" && --depth === 0)
				return JSON.parse(body.slice(0, token.index + 1));
		}
	} catch {
		return null;
	}
	return null;
}
