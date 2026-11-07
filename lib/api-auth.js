export function parseBearer(req) {
  const value = req?.headers?.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(value.trim());
  return match?.[1] || null;
}

export function authorizeCredential(authContext, requiredScope) {
  return Boolean(authContext && Array.isArray(authContext.scopes) && authContext.scopes.includes(requiredScope));
}

export function authenticateRequest(req, appService, requiredScope) {
  const context = appService.authenticateCredential(parseBearer(req));
  return context && authorizeCredential(context, requiredScope) ? context : null;
}
