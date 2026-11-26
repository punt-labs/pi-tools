export type CoderThinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface CoderConfig {
	provider: string;
	model: string;
	thinking?: CoderThinking;
}

const THINKING_LEVELS: readonly string[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

/** Resolve only non-secret settings; Pi resolves credentials from its provider configuration. */
export function resolveCoderConfig(env: NodeJS.ProcessEnv): CoderConfig {
	const provider = env.PI_CODER_PROVIDER?.trim();
	const model = env.PI_CODER_MODEL?.trim();
	const missing = [!provider && "PI_CODER_PROVIDER", !model && "PI_CODER_MODEL"].filter(Boolean);
	if (!provider || !model) {
		throw new Error("Configure " + missing.join(" and ") + " before calling pi_coder.");
	}
	const thinking = env.PI_CODER_THINKING?.trim();
	if (thinking && !THINKING_LEVELS.includes(thinking)) {
		throw new Error("PI_CODER_THINKING must be one of: " + THINKING_LEVELS.join(", ") + ".");
	}
	return { provider, model, ...(thinking ? { thinking: thinking as CoderThinking } : {}) };
}
