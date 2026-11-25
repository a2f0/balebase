import type {
  OfflineFormState,
  OfflineOperation,
} from "@balebase/validators/offline";
import { progressFor } from "../forms/formProgress";
import { type OfflineForm, type OfflineJob, pendingJob } from "./offlineStore";

type FormWrite = Extract<
  OfflineOperation,
  { type: "formStart" } | { type: "formSave" }
>;

/** A queued server write of a form: its start, or a save. */
export type FormWriteJob = OfflineJob & { operation: FormWrite };

/**
 * What happens to a form on this device. The caller supplies new IDs and
 * times, so the transition stays pure.
 */
export type OfflineFormEvent =
  /**
   * An answer given at `at` over the server answer of version `base`: the
   * one shown when it was given (`answerBase`).
   */
  | {
      at: string;
      base: string | null;
      itemId: string;
      type: "answered";
      value: string;
    }
  /** Share a draft with the server, as an in-progress form. */
  | { type: "shared" }
  /** An issue was raised on one of its items; the issue needs it on the server. */
  | { type: "issueRaised" }
  /** Send the answers given here since the last write. */
  | { saveId: string; type: "pushed" }
  | { completedAt: string; saveId: string; type: "completed" }
  /** The server applied write `job`, answering with its copy of the form. */
  | { job: string; state: OfflineFormState; type: "confirmed" }
  /** The server's copy, read for what others changed. */
  | { state: OfflineFormState; type: "pulled" };

/** The form after an event, and the server writes the event queues. */
export interface OfflineFormStep {
  form: OfflineForm;
  queue: FormWriteJob[];
}

/** The form's queued server writes, oldest first: its start, then each save. */
export function formWrites(jobs: OfflineJob[], formId: string) {
  return jobs.filter(
    (job): job is FormWriteJob =>
      (job.operation.type === "formStart" && job.operation.id === formId) ||
      (job.operation.type === "formSave" && job.operation.formId === formId),
  );
}

/**
 * The answers shown: the server's, under those being sent, under newer ones.
 * An answer cleared on the server shows as unanswered.
 */
export function offlineAnswers(form: OfflineForm) {
  const answers = new Map<string, string>();
  for (const layer of [
    form.server.answers,
    ...form.sending.map((entry) => entry.answers),
    form.local,
  ])
    for (const [itemId, { value }] of Object.entries(layer))
      if (value === null) answers.delete(itemId);
      else answers.set(itemId, value);
  return Object.fromEntries(answers);
}

/** Whether answers given here have yet to reach the server. */
export function unsyncedAnswers(form: OfflineForm) {
  return Object.keys(form.local).length > 0 || form.sending.length > 0;
}

/**
 * Whether answers given here are due to be sent: the form is shared, every
 * write before has synced (one save at a time keeps answers coalesced), and
 * there is something to send. A completed form still sends answers written
 * after it was sealed, which the server records as discarded.
 */
export function pushDue(form: OfflineForm, writes: FormWriteJob[]) {
  return (
    form.status !== "draft" &&
    Object.keys(form.local).length > 0 &&
    writes.length > 0 &&
    writes.every((job) => job.status === "synced")
  );
}

/**
 * Moves a device form, given its queued writes:
 *
 * | status     | answered   | shared, issueRaised | pushed         | completed              | confirmed, pulled                  |
 * | ---------- | ---------- | ------------------- | -------------- | ---------------------- | ---------------------------------- |
 * | draft      | draft      | inProgress, start   | ignored        | completed, start, save | ignored                            |
 * | inProgress | inProgress | ignored             | save, when due | completed, save        | completed if done there            |
 * | completed  | completed  | ignored             | save, when due | ignored                | inProgress if not applied/reopened |
 *
 * Answers given here wait in `local` until a write carries them, then in
 * `sending` until the server confirms it. The server's copy replaces
 * `server` unless it is older than the one held. An answer older than one
 * given here since, such as another tab retrying an earlier edit, is
 * ignored. An answer the editor was still writing when a completion made
 * elsewhere sealed the form is kept and sent, so the server records it
 * rather than the device losing it. Completing throws while a required item
 * is unanswered.
 */
export function offlineFormTransition(
  form: OfflineForm,
  writes: FormWriteJob[],
  event: OfflineFormEvent,
): OfflineFormStep {
  const unchanged = { form, queue: [] };
  switch (event.type) {
    case "answered":
      return { form: answer(form, event), queue: [] };
    case "shared":
    case "issueRaised":
      return form.status === "draft" ? start(form) : unchanged;
    case "pushed":
      return pushDue(form, writes)
        ? send(form, writes, event.saveId)
        : unchanged;
    case "completed": {
      if (form.status === "completed") return unchanged;
      if (
        progressFor(form.template.definition, offlineAnswers(form))
          .requiredLeft > 0
      )
        throw new Error("Complete every required item first.");
      const begun = form.status === "draft" ? start(form) : unchanged;
      const sent = send(begun.form, [...writes, ...begun.queue], event.saveId, {
        startedAt: form.startedAt,
        completedAt: event.completedAt,
      });
      return {
        form: { ...sent.form, status: "completed" },
        queue: [...begun.queue, ...sent.queue],
      };
    }
    case "confirmed":
      return {
        form: pull(confirm(form, event.job, event.state), writes, event.state),
        queue: [],
      };
    case "pulled":
      return { form: pull(form, writes, event.state), queue: [] };
    default:
      return unknownEvent(event);
  }
}

/** Takes an answer given here, unless one given here since replaced it. */
function answer(
  form: OfflineForm,
  event: Extract<OfflineFormEvent, { type: "answered" }>,
): OfflineForm {
  const newer = [form.local, ...form.sending.map((entry) => entry.answers)]
    .map((answers) => own(answers, event.itemId))
    .some((given) => given && Date.parse(given.at) > Date.parse(event.at));
  if (newer) return form;
  const replaced = { ...form.replaced };
  delete replaced[event.itemId];
  return {
    ...form,
    local: {
      ...form.local,
      [event.itemId]: { at: event.at, base: event.base, value: event.value },
    },
    replaced,
  };
}

/**
 * The version of the server answer an answer to `itemId` is given over: the
 * one shown, unless that is itself an answer from here, whose write's ID
 * names the version it becomes, or one no write carries yet, which keeps the
 * base it was given over. Taken when the answer is given, so a server copy
 * read meanwhile cannot claim it was seen.
 */
export function answerBase(form: OfflineForm, itemId: string) {
  const local = own(form.local, itemId);
  if (local) return local.base;
  for (const entry of [...form.sending].reverse())
    if (Object.hasOwn(entry.answers, itemId)) return entry.job;
  return own(form.server.answers, itemId)?.version ?? null;
}

/**
 * `record[key]` if `key` is its own property. Item IDs are any text, so IDs
 * such as `constructor` must not find inherited members.
 */
export function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Puts a draft on the server, in progress, under its own ID. */
function start(form: OfflineForm): OfflineFormStep {
  return {
    form: {
      ...form,
      local: {},
      sending: [
        ...form.sending,
        { answers: form.local, completes: false, job: form.id },
      ],
      status: "inProgress",
    },
    queue: [
      pendingJob(
        {
          id: form.id,
          type: "formStart",
          projectId: form.projectId,
          templateId: form.template.id,
          templateVersion: form.template.version,
          answers: Object.fromEntries(
            Object.entries(form.local).map(([itemId, { at, value }]) => [
              itemId,
              { at, value },
            ]),
          ),
        },
        [],
      ),
    ],
  };
}

/** Sends the answers given here since the last write, after that write. */
function send(
  form: OfflineForm,
  writes: FormWriteJob[],
  id: string,
  completion?: { completedAt: string; startedAt: string },
): OfflineFormStep {
  const last = writes.at(-1);
  if (!last) throw new Error("This form is not on the server yet.");
  return {
    form: {
      ...form,
      local: {},
      sending: [
        ...form.sending,
        { answers: form.local, completes: completion !== undefined, job: id },
      ],
    },
    queue: [
      pendingJob(
        {
          id,
          type: "formSave",
          formId: form.id,
          answers: form.local,
          ...(completion ? { completion } : {}),
        },
        [last.id],
      ),
    ],
  };
}

/**
 * Drops a confirmed write, noting each of its answers the newest server copy
 * held does not keep, unless a newer answer from here replaces it anyway.
 * Its status then follows that copy (`pull`): a completion it does not show,
 * because a required answer was cleared elsewhere or the form was reopened
 * since, opens the form here again.
 */
function confirm(
  form: OfflineForm,
  job: string,
  state: OfflineFormState,
): OfflineForm {
  const index = form.sending.findIndex((entry) => entry.job === job);
  const entry = form.sending[index];
  if (!entry) return form;
  const later = [
    ...form.sending.slice(index + 1).map((other) => other.answers),
    form.local,
  ];
  const newest = state.revision < form.server.revision ? form.server : state;
  const notes = Object.entries(entry.answers).flatMap(([itemId, sent]) =>
    own(newest.answers, itemId)?.value !== sent.value &&
    !later.some((answers) => Object.hasOwn(answers, itemId))
      ? [[itemId, { at: sent.at, value: sent.value }]]
      : [],
  );
  return {
    ...form,
    replaced: { ...form.replaced, ...Object.fromEntries(notes) },
    sending: form.sending.filter((other) => other.job !== job),
  };
}

/**
 * Takes the server's copy unless it is older than the one held, then
 * follows the newest copy held: a completion made elsewhere seals the form
 * here once nothing from here is still on its way (the server records any
 * answer from here it then discards), and a copy showing the form in
 * progress again opens it here once no completion from here is still on its
 * way. Reconciling against the copy held, not the one arriving, lets a late
 * confirmation follow a newer copy already held.
 */
function pull(
  form: OfflineForm,
  writes: FormWriteJob[],
  state: OfflineFormState,
): OfflineForm {
  const server =
    state.revision < form.server.revision
      ? form.server
      : {
          answers: state.answers,
          revision: state.revision,
          status: state.status,
        };
  return { ...form, server, status: followed(form, writes, server.status) };
}

/** The status here once it follows the server's status `there`. */
function followed(
  form: OfflineForm,
  writes: FormWriteJob[],
  there: OfflineForm["server"]["status"],
): OfflineForm["status"] {
  if (
    form.status === "inProgress" &&
    there === "completed" &&
    !unsyncedAnswers(form) &&
    writes.every((job) => job.status === "synced")
  )
    return "completed";
  if (
    form.status === "completed" &&
    there === "in_progress" &&
    !form.sending.some((entry) => entry.completes)
  )
    return "inProgress";
  return form.status;
}

function unknownEvent(event: never): never {
  throw new Error(`Unknown offline form event: ${JSON.stringify(event)}`);
}
