function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function replyJson(answer: string): unknown {
	const fences =
		/^ {0,3}(```+|~~~+)[^\r\n]*\r?\n([\s\S]*?)^ {0,3}\1[ \t]*\r?$/gm;
	for (const fence of answer.matchAll(fences)) {
		const value = parse(fence[2]!);
		if (value !== undefined) return value;
	}

	// Start each candidate independently so an unmatched prose bracket cannot hide a report.
	for (const open of answer.matchAll(/[[{]/g)) {
		const body = answer.slice(open.index);
		const close = open[0] === "{" ? "}" : "]";
		let depth = 0;
		for (const token of body.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[[\]{}]/g)) {
			if (token[0] === open[0]) depth++;
			if (token[0] === close && --depth === 0) {
				const value = parse(body.slice(0, token.index + 1));
				if (value !== undefined) return value;
				break;
			}
		}
	}
	return null;
}
