import { LoadingState } from "@balebase/ui/react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { type ReactNode, useEffect, useReducer, useRef, useState } from "react";
import {
  isRenderCancellation,
  openPdf,
  renderPdfPage,
} from "../shared/pdfDocument";
import { contractPdfReducer } from "./contractPdfState";

/** A page's size in PDF points as displayed, after any /Rotate. */
export interface PageSize {
  height: number;
  number: number;
  width: number;
}

interface LoadedPdf {
  document: PDFDocumentProxy;
  pages: PageSize[];
}

/**
 * Renders every page of a PDF with an overlay layer above each one. Overlays
 * position content with percentages, so it lines up at any rendered width.
 */
export function ContractPages({
  load,
  renderOverlay,
  onPageRendered,
  onFailed,
}: {
  load: () => Promise<ArrayBuffer>;
  renderOverlay?: (page: PageSize) => ReactNode;
  onPageRendered?: (pageNumber: number) => void;
  onFailed?: () => void;
}) {
  const { pdf, fail } = useContractPdf(load);
  const failureCallback = useRef(onFailed);
  failureCallback.current = onFailed;
  useEffect(() => {
    if (pdf.status === "failed") failureCallback.current?.();
  }, [pdf]);
  if (pdf.status === "failed") {
    return (
      <p className="contractPagesMessage">
        This document could not be displayed.
      </p>
    );
  }
  if (pdf.status !== "loaded")
    return <LoadingState label="Opening document…" />;
  const { document, pages } = pdf.document;
  return (
    <div className="contractPages">
      {pages.map((page) => (
        <section
          aria-label={`Page ${page.number} of ${pages.length}`}
          className="contractPage"
          data-theme="light"
          key={page.number}
          style={{ aspectRatio: `${page.width} / ${page.height}` }}
        >
          <LazyPageCanvas
            document={document}
            pageNumber={page.number}
            onRendered={onPageRendered}
            onFailed={fail}
          />
          {renderOverlay && (
            <div className="contractPageOverlay">{renderOverlay(page)}</div>
          )}
        </section>
      ))}
    </div>
  );
}

function useContractPdf(load: () => Promise<ArrayBuffer>) {
  const [state, dispatch] = useReducer(contractPdfReducer<LoadedPdf>, {
    status: "loading",
    request: 0,
  });
  const requests = useRef(0);
  // The loader changes identity on every render; load once per mount.
  const loader = useRef(load);
  useEffect(() => {
    const request = ++requests.current;
    dispatch({ type: "start", request });
    let active = true;
    let task: PDFDocumentLoadingTask | undefined;
    Promise.resolve()
      .then(() => loader.current())
      .then((bytes) => (active ? openPdf(bytes) : undefined))
      .then((started) => {
        if (!started) return undefined;
        task = started;
        if (!active) void started.destroy();
        return started.promise;
      })
      .then(async (document) => {
        if (!active || !document) return;
        const pages: PageSize[] = [];
        for (let number = 1; number <= document.numPages; number += 1) {
          const viewport = (await document.getPage(number)).getViewport({
            scale: 1,
          });
          pages.push({
            height: viewport.height,
            number,
            width: viewport.width,
          });
        }
        if (active) {
          dispatch({
            type: "loaded",
            request,
            document: { document, pages },
          });
        }
      })
      .catch(() => {
        if (active) dispatch({ type: "failed", request });
      });
    return () => {
      active = false;
      void task?.destroy();
    };
  }, []);
  return {
    pdf: state,
    fail: () => dispatch({ type: "failed", request: state.request }),
  };
}

/** The widest a page renders in device pixels, to bound canvas memory. */
const maxCanvasPixels = 2000;

/**
 * Renders a page while it is near the viewport, at the width it is shown, and
 * frees its canvas once it is far away so long documents fit in memory.
 */
function LazyPageCanvas({
  document,
  pageNumber,
  onRendered,
  onFailed,
}: {
  document: PDFDocumentProxy;
  pageNumber: number;
  onRendered: ((pageNumber: number) => void) | undefined;
  onFailed: () => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const callbacks = useRef({ onRendered, onFailed });
  callbacks.current = { onRendered, onFailed };
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) setVisible(entry.isIntersecting);
      },
      { rootMargin: "1200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    if (!visible) {
      element.width = 0;
      element.height = 0;
      return;
    }
    let active = true;
    let task: RenderTask | undefined;
    const width = Math.min(
      element.clientWidth || 800,
      1200,
      maxCanvasPixels / (window.devicePixelRatio || 1),
    );
    renderPdfPage(document, pageNumber, element, width)
      .then((started) => {
        task = started;
        if (!active) started.cancel();
        return started.promise;
      })
      .then(() => {
        if (active) callbacks.current.onRendered?.(pageNumber);
      })
      .catch((error: unknown) => {
        if (active && !isRenderCancellation(error)) {
          console.error(error);
          callbacks.current.onFailed();
        }
      });
    return () => {
      active = false;
      task?.cancel();
    };
  }, [document, pageNumber, visible]);
  return <canvas className="contractPageCanvas" ref={canvas} />;
}

/** Percent-based absolute placement for a field box. */
export function boxStyle(box: {
  height: number;
  width: number;
  x: number;
  y: number;
}) {
  return {
    height: `${box.height * 100}%`,
    left: `${box.x * 100}%`,
    top: `${box.y * 100}%`,
    width: `${box.width * 100}%`,
  };
}
