
import { runPrompt } from './main';

const prompts = {
	researchProseMirror: `/fleet You are a technical researcher agent. Your first task is to research prosemirror. Understand how it works, how input is processed, and how rendering is done. We need to understand in full detail how it's data model works, and how the different components interact with each other. For context, we are going to be building a new editor inspired by prosemirror, but for better DX and extensibility. So we need to understand how prosemirror works in order to build something better, while understanding browser constraints and how to work with them. Write documents and findings in the research folder.`,
	qualityAssurance: `/fleet You are a quality assurance agent. Your task is to review the research done on prosemirror by the technical researcher agent. Review the documents and findings in the research folder, and the summary provided by the technical researcher. Provide feedback on the quality of the research, and whether it meets our standards for thoroughness and accuracy. If it does, respond with 'approved'. If not, provide detailed feedback on what is missing or needs improvement. This will be fed back to the technical researcher agent to improve the research until it meets our standards.`,
	implementPlim: `/fleet You are a technical implementation agent (SWE). Your task is to implement the library called 'plim' based on the research done on prosemirror that is available in the "research" folder. You MUST make sure the API surface follows the required specification outlined in the "research/plim-architecture" folder. That folder contains the required API designs that must be implemented. It outlines how users will be using the library to create their own editors. Make sure to implement the necessary tests to make sure it works as expected for both react and vanilla environments. Follow best practices for code quality, testing, and documentation. Make sure to write clean, maintainable, and well-documented code. The implementation should be done in a way that allows for easy extensibility and customization by users. The code for the library should live in the 'packages' folder. Once implementation is done, create examples in the 'examples' folder; one for react and one for vanilla, showcasing how to use the library to create a basic editor. The examples should be simple but comprehensive enough to demonstrate the core features of the library. The examples should look like the notion editor. You should use playwright and browsing tools you have available to check notion and make sure your examples have similar behaviors and design.`,
	implementationQualityAssurance: `/fleet You are a quality assurance agent. Your task is to review the implementation of the 'plim' library by the technical implementer agent. Review the code, tests, and documentation of the implementation. Provide feedback on the quality of the implementation, and whether it meets our standards for code quality, testing, and documentation. If it does, respond with 'approved'. If not, provide detailed feedback on what is missing or needs improvement. This will be fed back to the technical implementer agent to improve the implementation until it meets our standards.`,
}

const qualityAssuranceChecks = {
	"prosemirror-research": false,
	"implementation": false,
};

let feedbackText: string | null = null;

while (qualityAssuranceChecks['prosemirror-research'] === false) {
	console.log('[Task]: Researching prosemirror');

	const researchPrompt = prompts.researchProseMirror + (feedbackText ? `\n\n[Feedback from Quality Assurance]: ${feedbackText}\n\n` : '');

	const out = await runPrompt(researchPrompt, "gpt-5.5");

	console.log('[Result]:', out);

	console.log('[Task]: Quality Assurance Check for prosemirror research');

	const qaOut = await runPrompt(`
		<original request>
		${prompts.researchProseMirror}
		</original request>

		<research output>
		${out}
		</research output>

		${prompts.qualityAssurance}
		`.trim(), 'gpt-5.5'
	);

	if (qaOut.toLowerCase().includes('approve')) {
		qualityAssuranceChecks['prosemirror-research'] = true;
		console.log('[Quality Assurance]: Research approved');
	} else {
		console.log('[Quality Assurance]: Research not approved. Feedback:\n', qaOut);
		feedbackText = qaOut;
	}

}

feedbackText = null;

while (qualityAssuranceChecks['implementation'] === false) {
	console.log('[Task]: Implementing plim library');

	const implementPrompt = prompts.implementPlim + (feedbackText ? `\n\n[Feedback from Quality Assurance]: ${feedbackText}\n\n` : '');
	const result = await runPrompt(implementPrompt, "gpt-5.5");

	console.log('[Result]: Implementation Summary:\n', result);

	console.log('[Task]: Quality Assurance Check for plim implementation');

	const qaText = await runPrompt(`
		<original request>
		${prompts.implementPlim}
		</original request>

		<implementation summary>
		${result}
		</implementation summary>

		${prompts.implementationQualityAssurance}
		`, "claude-opus-4.7"
	);

	if (qaText.toLowerCase().includes('approve')) {
		qualityAssuranceChecks['implementation'] = true;
		console.log('[Quality Assurance]: Implementation approved');
	} else {
		console.log('[Quality Assurance]: Implementation not approved. Feedback:\n', qaText);
		feedbackText = qaText;
	}

}
	
console.log('All tasks completed successfully!');