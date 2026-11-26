/**
 * Controllers whose routes accept credentials, one-time codes or invite tokens: the only
 * routes the strict `auth` throttle applies to. The decision is made from the controller Nest
 * matched, never from the URL text: Express routes case-insensitively and tolerates trailing
 * slashes, so a string match on the path could be dodged by rewriting it.
 */
const CREDENTIAL_CONTROLLERS: ReadonlySet<string> = new Set([
  'AuthController',
  'CanaryAuthController',
  'CrmWfStaffLinkController',
]);

export function isCredentialController(name: string | undefined): boolean {
  return !!name && CREDENTIAL_CONTROLLERS.has(name);
}
