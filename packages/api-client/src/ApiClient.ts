import { accountSettingsApi } from "./accountSettings";
import { activityApi } from "./activity";
import { adminFormTemplatesApi } from "./adminFormTemplates";
import { adminJobsApi } from "./adminJobs";
import { adminOrganizationsApi } from "./adminOrganizations";
import { adminUsersApi } from "./adminUsers";
import { apiKeysApi } from "./apiKeys";
import { billingApi } from "./billing";
import { businessesApi } from "./businesses";
import { contractsApi } from "./contracts";
import { contractTemplatesApi } from "./contractTemplates";
import { employeeFormsApi } from "./employeeForms";
import { equipmentApi } from "./equipment";
import { financeApi } from "./finance";
import { formsApi } from "./forms";
import { inboxApi } from "./inbox";
import { issuesApi } from "./issues";
import { libraryFoldersApi } from "./libraryFolders";
import { objectsApi } from "./objects";
import { offlineApi } from "./offline";
import { organizationGroupsApi } from "./organizationGroups";
import { organizationSettingsApi } from "./organizationSettings";
import { projectsApi } from "./projects";
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
  readonly adminFormTemplates = adminFormTemplatesApi(this);
  readonly adminJobs = adminJobsApi(this);
  readonly adminOrganizations = adminOrganizationsApi(this);
  readonly adminUsers = adminUsersApi(this);
  readonly apiKeys = apiKeysApi(this);
  readonly forms = formsApi(this);
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
  readonly projects = projectsApi(this);
  readonly session = sessionApi(this);
  readonly signing = signingApi(this);
}
