export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'auth_error'
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
export class UnauthorizedError extends AuthError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'unauthorized');
  }
}
export class ForbiddenError extends AuthError {
  constructor(message = 'Access denied') {
    super(message, 403, 'forbidden');
  }
}
