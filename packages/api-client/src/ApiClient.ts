import { accountSettingsApi } from "./accountSettings";
import { activityApi } from "./activity";
import { adminAuditTemplatesApi } from "./adminAuditTemplates";
import { adminJobsApi } from "./adminJobs";
import { adminOrganizationsApi } from "./adminOrganizations";
import { apiKeysApi } from "./apiKeys";
import { auditsApi } from "./audits";
import { billingApi } from "./billing";
import { businessesApi } from "./businesses";
import { contractsApi } from "./contracts";
import { contractTemplatesApi } from "./contractTemplates";
import { employeeFormsApi } from "./employeeForms";
import { equipmentApi } from "./equipment";
import { financeApi } from "./finance";
import { inboxApi } from "./inbox";
import { issuesApi } from "./issues";
import { libraryFoldersApi } from "./libraryFolders";
import { objectsApi } from "./objects";
import { offlineApi } from "./offline";
import { organizationGroupsApi } from "./organizationGroups";
import { organizationSettingsApi } from "./organizationSettings";
import { sessionApi } from "./session";
import { signingApi } from "./signing";
import { Transport } from "./transport";

/**
 * Every API call the app makes, grouped by area. Each method sends one route
 * from the shared contract, so its input and result are typed by it.
 */
export class ApiClient extends Transport {
  readonly accountSettings = accountSettingsApi(this);
  readonly activity = activityApi(this);
  readonly adminAuditTemplates = adminAuditTemplatesApi(this);
  readonly adminJobs = adminJobsApi(this);
  readonly adminOrganizations = adminOrganizationsApi(this);
  readonly apiKeys = apiKeysApi(this);
  readonly audits = auditsApi(this);
  readonly billing = billingApi(this);
  readonly businesses = businessesApi(this);
  readonly contracts = contractsApi(this);
  readonly contractTemplates = contractTemplatesApi(this);
  readonly employeeForms = employeeFormsApi(this);
  readonly equipment = equipmentApi(this);
  readonly finance = financeApi(this);
  readonly inbox = inboxApi(this);
  readonly issues = issuesApi(this);
  readonly libraryFolders = libraryFoldersApi(this);
  readonly objects = objectsApi(this);
  readonly offline = offlineApi(this);
  readonly organizationGroups = organizationGroupsApi(this);
  readonly organizationSettings = organizationSettingsApi(this);
  readonly session = sessionApi(this);
  readonly signing = signingApi(this);
}
