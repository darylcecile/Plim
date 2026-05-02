import type { ValidationIssue } from './types.js';

export class ModelError extends Error {
  readonly code: string;
  readonly issues?: ValidationIssue[];

  constructor(code: string, message: string, issues?: ValidationIssue[]) {
    super(message);
    this.name = 'ModelError';
    this.code = code;
    if (issues) this.issues = issues;
  }
}
