/**
 * For test fixtures only, as `@balebase/client-sdk/testing`. The device's
 * raw offline store, whose `change` writes a workspace directly, without the
 * form state machine and sync queue that `balebase.offline` keeps. Seeding a
 * device for a test is its one use; hosts never need it. A store for the
 * same API as a `Balebase` shares its storage, locks, and change
 * subscribers.
 */
export { OfflineStore } from "./client/offline/offlineStore";
