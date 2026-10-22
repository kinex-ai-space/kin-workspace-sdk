export {
  type AppSwitcherItem,
  AppSwitcherStatus,
  appSwitcherItems,
  type CurrentAppOptions,
  hasAccessToCurrentApp,
  isCurrentApp,
  originOf,
  parseAllowedApps,
  parseOriginAliases,
  type WorkspaceAllowedApp,
} from "./core/allowedApps";
export {
  ACCOUNT_ISSUE_EVENT,
  type AccountIssue,
  AccountIssueReason,
  dispatchAccountIssue,
  onAccountIssue,
  parseAccountIssue,
} from "./core/accountIssue";
export {
  currentRelativeUrl,
  isAbsoluteUrl,
  safeReturnPath,
  signInUrlWithReturn,
} from "./core/signIn";
export {
  type ClerkSessionLike,
  createAuthorizedFetch,
  createClerkTokenGetter,
  DEFAULT_JWT_TEMPLATE,
  type TokenGetter,
  windowClerkSession,
} from "./core/token";
