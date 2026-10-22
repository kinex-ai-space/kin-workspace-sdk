/**
 * Account issues: the user is signed in to Clerk (the Hub's instance) but this app cannot
 * use the identity. App APIs answer 403 with `{ error: "<code>", email? }`.
 */

export enum AccountIssueReason {
  /** No app account is linked to the Clerk user / email. */
  NotLinked = "account_not_linked",
  /** The linked app account is disabled. */
  Inactive = "account_inactive",
  /** The app account could not be loaded (network / unexpected API error). */
  LoadFailed = "load_failed",
}

export interface AccountIssue {
  reason: AccountIssueReason;
  /** Email the API matched against, when the response carries it. */
  email: string | null;
}

/** API error codes per reason; LKS answers `clerk_user_not_provisioned` for "not linked". */
const API_CODES: Readonly<Record<string, AccountIssueReason>> = {
  account_not_linked: AccountIssueReason.NotLinked,
  clerk_user_not_provisioned: AccountIssueReason.NotLinked,
  account_inactive: AccountIssueReason.Inactive,
};

/**
 * Reads an account issue from an API error body: `{ error: "account_not_linked" }` or
 * the nested `{ error: { code: "account_inactive" } }` shape. Null for anything else.
 */
export function parseAccountIssue(body: unknown): AccountIssue | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const error = record.error;
  const code =
    typeof error === "string"
      ? error
      : typeof error === "object" &&
          error !== null &&
          typeof (error as Record<string, unknown>).code === "string"
        ? ((error as Record<string, unknown>).code as string)
        : null;
  const reason = code ? API_CODES[code] : undefined;
  if (!reason) return null;
  return {
    reason,
    email: typeof record.email === "string" ? record.email : null,
  };
}

/** Window event an API client fires when any request is rejected with an account issue. */
export const ACCOUNT_ISSUE_EVENT = "kinex-workspace:account-issue";

export function dispatchAccountIssue(issue: AccountIssue): void {
  window.dispatchEvent(
    new CustomEvent<AccountIssue>(ACCOUNT_ISSUE_EVENT, { detail: issue }),
  );
}

/** Subscribes to account issues; returns the unsubscribe function. */
export function onAccountIssue(
  listener: (issue: AccountIssue) => void,
): () => void {
  const handler = (event: Event) => {
    if (event instanceof CustomEvent && event.type === ACCOUNT_ISSUE_EVENT) {
      listener(event.detail as AccountIssue);
    }
  };
  window.addEventListener(ACCOUNT_ISSUE_EVENT, handler);
  return () => window.removeEventListener(ACCOUNT_ISSUE_EVENT, handler);
}
