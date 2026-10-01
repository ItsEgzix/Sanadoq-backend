/**
 * The one way a caught `unknown` becomes a loggable string. Never log the
 * error object itself — driver errors carry connection strings and query
 * parameters.
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Unknown error';
}
