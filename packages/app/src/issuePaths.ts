export function issuePath(id: string) {
  return `/issues/${encodeURIComponent(id)}`;
}
export function transactionIssuePath(id: string) {
  return `/issues/new/transactions/${encodeURIComponent(id)}`;
}
