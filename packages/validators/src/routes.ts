import { accountSettingsRoutes } from "./accountSettings";
import { activityRoutes } from "./activity";
import { adminAuditTemplatesRoutes } from "./adminAuditTemplates";
import { adminJobsRoutes } from "./adminJobs";
import { adminOrganizationsRoutes } from "./adminOrganizations";
import { adminUsersRoutes } from "./adminUsers";
import { apiKeysRoutes } from "./apiKeys";
import { auditsRoutes } from "./audits";
import { billingRoutes } from "./billing";
import { businessesRoutes } from "./businesses";
import { contractsRoutes } from "./contracts";
import { contractTemplatesRoutes } from "./contractTemplates";
import { employeeFormsRoutes } from "./employeeForms";
import { equipmentRoutes } from "./equipment";
import { financeRoutes } from "./finance";
import { inboxRoutes } from "./inbox";
import { issuesRoutes } from "./issues";
import { libraryFoldersRoutes } from "./libraryFolders";
import { objectsRoutes } from "./objects";
import { offlineRoutes } from "./offline";
import { organizationGroupsRoutes } from "./organizationGroups";
import { organizationSettingsRoutes } from "./organizationSettings";
import type { Route } from "./route";
import { sessionRoutes } from "./session";
import { signingRoutes } from "./signing";

/** Every route in the contract, by area. The API serves exactly these. */
export const routes: Record<string, Record<string, Route>> = {
  accountSettings: accountSettingsRoutes,
  activity: activityRoutes,
  adminAuditTemplates: adminAuditTemplatesRoutes,
  adminJobs: adminJobsRoutes,
  adminOrganizations: adminOrganizationsRoutes,
  adminUsers: adminUsersRoutes,
  apiKeys: apiKeysRoutes,
  audits: auditsRoutes,
  billing: billingRoutes,
  businesses: businessesRoutes,
  contracts: contractsRoutes,
  contractTemplates: contractTemplatesRoutes,
  employeeForms: employeeFormsRoutes,
  equipment: equipmentRoutes,
  finance: financeRoutes,
  inbox: inboxRoutes,
  issues: issuesRoutes,
  libraryFolders: libraryFoldersRoutes,
  objects: objectsRoutes,
  offline: offlineRoutes,
  organizationGroups: organizationGroupsRoutes,
  organizationSettings: organizationSettingsRoutes,
  session: sessionRoutes,
  signing: signingRoutes,
};
