import { Button, Page, PageBody, PageHeader } from "@balebase/ui/react";
import { Component, type ReactNode } from "react";

/** Keep shell notices and dialogs mounted when an application screen crashes. */
export class AppBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Page>
        <PageHeader title="The app could not open" />
        <PageBody>
          <p>Try again, or apply an available update to reload the app.</p>
          <Button onClick={() => this.setState({ failed: false })}>
            Try again
          </Button>
        </PageBody>
      </Page>
    );
  }
}
