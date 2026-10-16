export class PreflightError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'PreflightError';
    this.code = code;
  }
}
