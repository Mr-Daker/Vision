import { test } from "node:test";
import assert from "node:assert/strict";

import { unsafeTimestamp } from "@vision/contracts";

import { buildDemoIdentityViewModel, renderDemoIdentityPanel } from "./identity-ui.ts";

const metadata = {
  contract_version: "1.0.0",
  generated_at: unsafeTimestamp("2026-09-09T10:00:00Z"),
  capabilities: [
    {
      capability: "citizen_identity",
      provider_name: "simulated-identity",
      provider_mode: "simulated",
      display_label: "Simulated demonstration identity — not a real identity check",
      v002_row: 1,
      may_claim: ["This is a simulated demo account"],
      must_not_claim: ["DigiLocker-verified"],
    },
  ],
  demo_principals: [
    {
      credential: "demo-active",
      label: "Demo citizen",
      credential_state: "active",
      issuer: "vision-simulated-demo-issuer",
    },
    {
      credential: "demo-revoked",
      label: "Revoked demo citizen",
      credential_state: "revoked",
      issuer: "vision-simulated-demo-issuer",
    },
  ],
} as const;

test("V009: identity UI visibly labels the provider as simulated", () => {
  const model = buildDemoIdentityViewModel(metadata);
  const html = renderDemoIdentityPanel(model);

  assert.equal(model.providerMode, "simulated");
  assert.match(model.providerLabel, /simulated/i);
  assert.match(model.warning, /does not verify a real person or a DigiLocker credential/i);
  assert.match(html, /data-provider-mode="simulated"/);
  assert.match(html, /Simulated demonstration identity/);
  assert.doesNotMatch(html, /Revoked demo citizen/);
});

test("V009: identity UI fails closed when simulation wording is removed", () => {
  assert.throws(
    () =>
      buildDemoIdentityViewModel({
        ...metadata,
        capabilities: [{ ...metadata.capabilities[0], display_label: "Identity verified" }],
      }),
    /explicit simulation label/,
  );
});

test("V009: identity UI escapes provider and principal copy", () => {
  const model = buildDemoIdentityViewModel({
    ...metadata,
    capabilities: [
      {
        ...metadata.capabilities[0],
        display_label: "Simulated <img src=x onerror=alert(1)>",
      },
    ],
    demo_principals: [
      {
        ...metadata.demo_principals[0],
        label: '<script>alert("x")</script>',
      },
    ],
  });
  const html = renderDemoIdentityPanel(model);

  assert.doesNotMatch(html, /<script>|<img/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&lt;img/);
});
