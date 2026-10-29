/** Deterministically signal scrolling in DOM tests without layout emulation. */
export class IntersectionObserverFixture {
  static instances: IntersectionObserverFixture[] = [];
  target: Element | undefined;

  constructor(private callback: IntersectionObserverCallback) {
    IntersectionObserverFixture.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  disconnect() {
    this.target = undefined;
  }

  notify() {
    this.callback(
      [
        {
          isIntersecting: true,
          target: this.target,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver,
    );
  }

  static intersect() {
    for (const observer of IntersectionObserverFixture.instances) {
      if (observer.target) observer.notify();
    }
  }
}
