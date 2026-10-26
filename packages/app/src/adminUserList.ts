export const adminUserPageSize = 25;

export function adminUserListQuery(page: number) {
  return { limit: adminUserPageSize, offset: page * adminUserPageSize };
}
