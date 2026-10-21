export async function openCurrentBillingSession<T>(
  request: () => Promise<T>,
  isCurrent: () => boolean,
  open: (result: T) => void,
) {
  const result = await request();
  if (!isCurrent()) return false;
  open(result);
  return true;
}
