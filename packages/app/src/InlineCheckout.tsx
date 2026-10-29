import { Button, Card, Toast } from "@balebase/ui/react";
import type { InlineCheckoutSession } from "@balebase/validators/billing";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage } from "./shared/errors";
import {
  type CheckoutSummary,
  type MountedCheckout,
  mountCheckout,
} from "./stripeCheckout";

/** Stripe's Payment Element for an inline Pro Checkout, styled like the app. */
export function InlineCheckout({
  onCancel,
  session,
}: {
  onCancel: () => void;
  session: InlineCheckoutSession;
}) {
  const host = useRef<HTMLDivElement>(null);
  const checkout = useRef<MountedCheckout | undefined>(undefined);
  const [summary, setSummary] = useState<CheckoutSummary>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const mounting = new AbortController();
    const { signal } = mounting;
    mountCheckout(
      element,
      session,
      (next) => {
        if (!signal.aborted) setSummary(next);
      },
      signal,
    )
      .then((mounted) => {
        if (!signal.aborted) checkout.current = mounted;
      })
      .catch((cause: unknown) => {
        if (!signal.aborted) setError(errorMessage(cause, "Checkout failed."));
      });
    return () => {
      mounting.abort();
      checkout.current = undefined;
    };
  }, [session]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const mounted = checkout.current;
    if (!mounted || submitting) return;
    setSubmitting(true);
    setError(undefined);
    const failure = await mounted
      .confirm()
      .catch((cause: unknown) => errorMessage(cause, "Checkout failed."));
    // Success navigates to the return URL, so only a failure resets the form.
    if (failure !== null) {
      setError(failure);
      setSubmitting(false);
    }
  }

  return (
    <Card
      className="billingCheckout"
      description={
        summary
          ? checkoutDescription(summary)
          : "Enter your payment details to start Pro."
      }
      footer={
        <>
          <Button disabled={submitting} onClick={onCancel} variant="secondary">
            Cancel
          </Button>
          {/* Confirming reports missing details in the form, so only loading disables it. */}
          <Button
            busy={submitting}
            disabled={!summary}
            type="submit"
            variant="primary"
          >
            {submitting ? "Subscribing…" : "Subscribe"}
          </Button>
        </>
      }
      onSubmit={(event) => void submit(event)}
      title="Upgrade to Pro"
    >
      {error && <Toast tone="danger">{error}</Toast>}
      <div className="billingCheckoutPayment" ref={host} />
    </Card>
  );
}

function checkoutDescription(summary: CheckoutSummary) {
  const renewal = summary.interval ? ` Renews every ${summary.interval}.` : "";
  return `${summary.dueToday} due today.${renewal}`;
}
