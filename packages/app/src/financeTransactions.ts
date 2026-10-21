/** Ordinary clicks focus one account; Shift toggles it within the selection. */
export function selectFinanceAccount(
  selected: string[],
  accountId: string,
  shiftKey: boolean,
) {
  if (shiftKey) {
    return selected.includes(accountId)
      ? selected.filter((id) => id !== accountId)
      : [...selected, accountId];
  }
  return selected.length === 1 && selected[0] === accountId ? [] : [accountId];
}
