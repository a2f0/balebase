import type {
  EquipmentInput,
  equipmentRoutes,
} from "@balebase/validators/equipment";
import { endpoint } from "./endpoint";
import type { Transport } from "./transport";

const endpoints = {
  list: endpoint<typeof equipmentRoutes.list>({
    method: "GET",
    path: "/api/equipment",
    response: "json",
  }),
  create: endpoint<typeof equipmentRoutes.create>({
    method: "POST",
    path: "/api/equipment",
    body: "json",
    response: "json",
  }),
  get: endpoint<typeof equipmentRoutes.get>({
    method: "GET",
    path: "/api/equipment/:id",
    response: "json",
  }),
  activity: endpoint<typeof equipmentRoutes.activity>({
    method: "GET",
    path: "/api/equipment/:id/activity",
    response: "json",
  }),
  update: endpoint<typeof equipmentRoutes.update>({
    method: "PATCH",
    path: "/api/equipment/:id",
    body: "json",
    response: "json",
  }),
  delete: endpoint<typeof equipmentRoutes.delete>({
    method: "DELETE",
    path: "/api/equipment/:id",
    response: "empty",
  }),
};

export function equipmentApi(transport: Transport) {
  return {
    list() {
      return transport.call(endpoints.list);
    },
    /** An item with the emails linked to it. */
    get(id: string) {
      return transport.call(endpoints.get, { params: { id } });
    },
    activity(id: string, cursor?: string) {
      return transport.call(endpoints.activity, {
        params: { id },
        query: { cursor },
      });
    },
    async create(input: EquipmentInput) {
      const { equipment } = await transport.call(endpoints.create, {
        body: input,
      });
      return equipment;
    },
    /** Updates the given fields; `assigneeId: null` unassigns the item. */
    async update(id: string, changes: Partial<EquipmentInput>) {
      const { equipment } = await transport.call(endpoints.update, {
        body: changes,
        params: { id },
      });
      return equipment;
    },
    delete(id: string) {
      return transport.call(endpoints.delete, { params: { id } });
    },
  };
}
