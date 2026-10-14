import { JSDOM } from "jsdom";
import { indexedDB } from "fake-indexeddb";
import { vi } from "vitest";
// Keep Node's byte-array realm for external WASM while using a real DOM for React.
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:5173",
});
for (const key of [
  "window",
  "document",
  "navigator",
  "location",
  "history",
  "localStorage",
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "HTMLAnchorElement",
  "Element",
  "Node",
  "DocumentFragment",
  "Event",
  "CustomEvent",
  "NodeFilter",
  "HTMLTextAreaElement",
  "HTMLSelectElement",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "DOMParser",
  "getComputedStyle",
  "URL",
] as const) {
  vi.stubGlobal(key, dom.window[key]);
}
vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
  setTimeout(() => callback(Date.now()), 0),
);
vi.stubGlobal("cancelAnimationFrame", clearTimeout);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

vi.stubGlobal("indexedDB", indexedDB);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();
window.requestAnimationFrame = requestAnimationFrame;
window.cancelAnimationFrame = cancelAnimationFrame;
