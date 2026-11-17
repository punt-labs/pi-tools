// Biff reports the end of a talk in two lines: the partner's hangup first
// ("<user> has ended the conversation.", format_talk_end), then the REPL's own
// "Talk with <user> ended." once it leaves talk mode. A read can land between
// them, so either line counts; matching only the second left the bridge stuck
// in talk mode, refusing every other biff tool.
export function isTalkHangup(text: string): boolean {
	if (text.includes(" has ended the conversation.")) return true;
	return text.includes("Talk with ") && (text.includes(" ended.") || text.includes(" cancelled."));
}
