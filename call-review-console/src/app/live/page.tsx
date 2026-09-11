import type { Metadata } from "next";

import { DESTINATIONS } from "asheard/reconciler";

import { LiveView, type PublicDestination } from "./live-view";

export const metadata: Metadata = { title: "Place a call" };

/**
 * The destination list is read here, on the server, and handed down.
 *
 * `DESTINATIONS` includes whatever `ASHEARD_EXTRA_DESTINATIONS` adds, and that
 * variable only exists on the server. When the client read the list itself, the
 * prerendered page showed every number and the page in the browser quietly
 * dropped the extra ones once it loaded. Rendering per request keeps the list
 * in step with the environment the POST route checks against.
 */
export const dynamic = "force-dynamic";

export default function LivePage() {
  const destinations: PublicDestination[] = DESTINATIONS.map((d) => ({
    id: d.id,
    label: d.label,
    e164: d.e164,
    expectation: d.expectation,
    why: d.why,
  }));
  return <LiveView destinations={destinations} />;
}
