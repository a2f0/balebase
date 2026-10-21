// Bundled into the page tabs browser check, which needs React effects.
import { PageHeader } from "@balebase/ui/react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

const tabs = ["General", "People", "Billing", "Access", "API keys"];

export function mount(element: HTMLElement) {
  const root = createRoot(element);
  return (current: string, title: string) =>
    flushSync(() =>
      root.render(
        <PageHeader
          tabs={tabs.map((tab) => (
            <a
              aria-current={tab === current ? "page" : undefined}
              className="tab"
              href={`#${tab}`}
              key={tab}
            >
              {tab}
            </a>
          ))}
          title={title}
        />,
      ),
    );
}
