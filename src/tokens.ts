/**
 * Counting tokens without a tokeniser.
 *
 * Four characters per token is the usual English approximation. Muninn uses it
 * for every budget it enforces — chunk size, the recall message, the run
 * transcript handed to the outcome model — because all three are *caps*, not
 * measurements: the cost of being 15 % out is a slightly smaller or slightly
 * larger prompt, and the cost of a real tokeniser is a dependency, a load-time
 * cost, and a second thing to keep in step with whichever model reads the
 * result.
 *
 * One approximation in one place, so the three budgets can never disagree
 * about what a token is.
 */

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** How many characters fit in a token budget. */
export function tokenBudgetChars(tokens: number): number {
	return tokens * CHARS_PER_TOKEN;
}
