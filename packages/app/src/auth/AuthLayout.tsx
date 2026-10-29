import { legalLinks, productName } from "@balebase/ui/brand";
import { Icon, type IconName, Logo } from "@balebase/ui/react";
import { type ReactNode, useEffect, useRef } from "react";
import { websiteUrl } from "../shared/config";

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="authShell">
      <AuthAside />
      <main className="authMain">
        <div className="authPanel">{children}</div>
        <AuthLegalLinks />
      </main>
    </div>
  );
}

export function AuthHeading({
  description,
  eyebrow,
  focusOnMount = false,
  title,
}: {
  description: string;
  eyebrow: string;
  focusOnMount?: boolean;
  title: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const shownTitle = useRef(focusOnMount ? undefined : title);
  // Switching forms removes the control that had focus. Move focus to the new
  // form's heading, whether the form replaced its title or was mounted in place
  // of another, so keyboard and screen-reader users start there rather than at
  // the top of the page; the first form keeps the page's initial focus.
  useEffect(() => {
    if (shownTitle.current === title) return;
    shownTitle.current = title;
    heading.current?.focus();
  }, [title]);
  return (
    <header className="authHeading">
      <p className="eyebrow">{eyebrow}</p>
      <h1 className="authTitle" ref={heading} tabIndex={-1}>
        {title}
      </h1>
      <p className="authIntro">{description}</p>
    </header>
  );
}

function AuthLegalLinks() {
  return (
    <nav aria-label="Legal" className="authLegal">
      {legalLinks.map((link) => (
        <a href={`${websiteUrl}${link.href}`} key={link.href}>
          {link.label}
        </a>
      ))}
    </nav>
  );
}

const asidePoints: ReadonlyArray<{
  description: string;
  icon: IconName;
  title: string;
}> = [
  {
    description: "Run inspections from reusable templates.",
    icon: "audits",
    title: "Audits and checklists",
  },
  {
    description: "Capture what needs fixing, right where you find it.",
    icon: "camera",
    title: "Issues with photos",
  },
  {
    description: "Invite your team and require two-factor authentication.",
    icon: "security",
    title: "Team access you control",
  },
];

function AuthAside() {
  return (
    <aside className="authAside onDark">
      <div className="authAsideInner">
        <a aria-label={`${productName} home`} className="authBrand" href="/">
          <Logo />
        </a>
        <div className="authAsideCopy">
          <p className="eyebrow eyebrowDot">Private by design</p>
          <p className="title authHeadline">
            Keep what matters.{" "}
            <span className="serifAccent">Lose the noise.</span>
          </p>
          <p className="lead">
            One quiet workspace for your audits, the issues they turn up, and
            the business records and files behind them.
          </p>
        </div>
        <ul className="authPoints">
          {asidePoints.map((point) => (
            <li className="authPoint" key={point.title}>
              <span className="authPointIcon">
                <Icon name={point.icon} />
              </span>
              <span className="authPointText">
                <strong>{point.title}</strong>
                <span>{point.description}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
