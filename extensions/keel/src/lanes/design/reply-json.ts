export function replyJson(answer: string): unknown {
	const body = answer.trim();
	const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(body);
	try {
		return JSON.parse(fenced?.[1] ?? body);
	} catch {
		return null;
	}
}
