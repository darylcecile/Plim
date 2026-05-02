import { spawn } from "bun";

const CLAUDE_OPUS_4_7 = 'claude-opus-4.7';
const OPENAI_GPT_5_5 = 'gpt-5.5';

export const models = {
	"opus": CLAUDE_OPUS_4_7,
	"gpt": OPENAI_GPT_5_5,
} as const;

type Model = typeof models[keyof typeof models];

export async function runPrompt(prompt:string, model:Model = OPENAI_GPT_5_5) {
	const task = spawn({
		cwd: process.cwd(),
		cmd: ['copilot', '-p', prompt, '-s', '--no-ask-user', '--allow-all', '--model', model],
		stdio: ['ignore', 'pipe', 'pipe']
	});

	if (await task.exited !== 0) {
		const err = task.stderr ? await new Response(task.stderr).text() : 'Unknown error';
		console.error('Error running copilot -', task, err);
		process.exit(task.exitCode);
	}

	const output = task.stdout ? await new Response(task.stdout).text() : '';
	return output;
}