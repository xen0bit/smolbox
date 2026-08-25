// Cross-origin isolation for hosts that cannot set headers.
//
// Everything here needs SharedArrayBuffer: xterm-pty's terminal I/O, the sync
// FS bridge that parks the VM worker on Atomics.wait while the main thread does
// an async read, and onnxruntime-web's threaded builds. A browser only hands
// out SharedArrayBuffer to a cross-origin-isolated document, and a document is
// isolated only when the server sends
//
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// web/serve.ts sends both on every response. GitHub Pages sends neither and
// offers no way to add them — there is no _headers file, no config, nothing.
// Without this file a Pages deployment of smolbox loads, renders, and then both
// pages stop at "cross-origin isolation required" forever.
//
// A service worker is the standard way out, and the only one: it sits between
// the page and the network, so it can add the two headers to a response the
// server never sent them on. The cost is one extra reload on the first visit —
// the document that registers the worker is not itself controlled by it, so the
// page has to come round again to be served through it and arrive isolated.
//
// This file plays both parts. Loaded as a classic script from a page it
// registers itself; loaded as a service worker it does the header rewriting.
// One file rather than two because the two halves are one decision, and because
// the registration needs the worker's URL — which, as `document.currentScript`,
// it already has.
//
// Deliberately plain JavaScript, not TypeScript compiled by bun:
// `navigator.serviceWorker.register` defaults to a classic worker, and the
// `{ type: "module" }` form that an ESM bundle would need is still unsupported
// in Firefox. Firefox is not incidental here — it is the only browser without
// showDirectoryPicker, so it is where the <input webkitdirectory> mount
// fallback is exercised (`make test-e2e-firefox`).

if (typeof window === "undefined") {
  // ---------------------------------------------------------- the worker half

  self.addEventListener("install", () => self.skipWaiting());

  // Claim the pages already open in this scope. Without it a freshly installed
  // worker controls nothing until every tab on the origin has been closed,
  // which for the visitor is indistinguishable from the worker not working.
  self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

  self.addEventListener("fetch", (event) => {
    const request = event.request;

    // Only our own responses need the headers, and only our own responses may
    // safely be rebuilt. A cross-origin request is left to the network
    // untouched: COEP constrains how *this document* embeds other origins'
    // resources, not what fetch() may retrieve, so the model weights coming
    // from huggingface.co need nothing from us. Proxying them through here
    // would mean re-wrapping gigabytes — including the 256 KB Range reads the
    // Gemma kernel engine streams a checkpoint with — for no gain at all.
    if (new URL(request.url).origin !== self.location.origin) {
      return;
    }

    // A cache-only request that misses cannot be re-issued to the network, so
    // respondWith(fetch(...)) would turn a miss into an error. Let it through.
    if (request.cache === "only-if-cached" && request.mode !== "same-origin") {
      return;
    }

    event.respondWith(
      fetch(request).then((response) => {
        // An opaque response (status 0) has no readable body or headers to
        // copy; constructing a new Response from one produces an empty 200.
        if (response.status === 0) {
          return response;
        }
        const headers = new Headers(response.headers);
        headers.set("Cross-Origin-Opener-Policy", "same-origin");
        headers.set("Cross-Origin-Embedder-Policy", "require-corp");
        // Status and statusText are carried over rather than defaulted: the
        // 206 that a Range request answers with is the whole point of
        // serve.ts's range support, and a 200 in its place hands the caller
        // the wrong bytes without saying so.
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }),
    );
  });
} else {
  // ------------------------------------------------------------- the page half

  // Already isolated — a real server sent the headers, which is what `make
  // serve` and the container image do. Registering here would install a worker
  // that duplicates what already works, and would then sit in front of every
  // request in local development for no reason. This is why the file is safe
  // to ship in every build rather than only in the Pages one.
  if (window.crossOriginIsolated) {
    // Nothing to do.
  } else if (!window.isSecureContext) {
    // Service workers need a secure context, and so does SharedArrayBuffer.
    // Say so rather than failing at registration with a DOMException whose
    // message does not mention the actual problem.
    console.error(
      "[coi] not a secure context: cross-origin isolation needs https:// or localhost",
    );
  } else if (!("serviceWorker" in navigator)) {
    console.error("[coi] no service worker support: this page needs COOP/COEP from the server");
  } else {
    const script = document.currentScript;
    // The reload guard. If the worker installs but the reloaded page still is
    // not isolated — a browser with service workers disabled by policy, a
    // private window that drops registrations — then reloading again would
    // reload forever. sessionStorage scopes the guard to this tab, so a later
    // visit gets one more honest attempt.
    const RELOADED = "smolbox-coi-reloaded";
    const reloadOnce = () => {
      let already = false;
      try {
        already = sessionStorage.getItem(RELOADED) === "1";
        sessionStorage.setItem(RELOADED, "1");
      } catch {
        // A browser refusing storage will not keep a registration either;
        // treat it as "already tried" so the page fails visibly instead of
        // looping.
        already = true;
      }
      if (already) {
        console.error("[coi] still not isolated after a reload; giving up");
        return;
      }
      window.location.reload();
    };

    navigator.serviceWorker
      .register(script ? script.src : "coi-serviceworker.js")
      .then((registration) => {
        // Two ways to arrive here. On the first visit the worker installs and
        // takes control, and `controllerchange` fires — the page is running
        // uncontrolled, so it must come round again to be served through the
        // worker. On a later visit the worker is already active but this
        // document was still fetched from the network before it could claim
        // it, which is the `registration.active && !controller` case.
        navigator.serviceWorker.addEventListener("controllerchange", reloadOnce);
        if (registration.active && !navigator.serviceWorker.controller) {
          reloadOnce();
        }
      })
      .catch((err) => console.error("[coi] service worker registration failed:", err));
  }
}
