import { describe, expect, it } from "vitest";

import { redactSecrets } from "../src/observability/redaction.js";

describe("redactSecrets", () => {
  it("redacts token-like values and bearer headers", () => {
    const redacted = redactSecrets(
      "TRACKER_TOKEN=abc123 Authorization: Bearer secret-value PASSWORD=hunter2",
    );

    expect(redacted).not.toContain("abc123");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).toContain("[redacted]");
  });

  it("redacts URL credentials and secret object keys", () => {
    const redacted = redactSecrets({
      remote: "https://oauth2:token@gitlab.example.com/group/project.git",
      webhookUrl: "https://hooks.slack.com/services/T000/B000/secret",
      nested: { apiKey: "key-value" },
    });

    expect(JSON.stringify(redacted)).not.toContain("token@gitlab");
    expect(JSON.stringify(redacted)).not.toContain("key-value");
    expect(redacted.webhookUrl).toBe("[redacted]");
    expect(redacted.nested.apiKey).toBe("[redacted]");
  });

  it("truncates long diagnostics", () => {
    const redacted = redactSecrets("x".repeat(20), 5);

    expect(redacted).toContain("xxxxx");
    expect(redacted).toContain("diagnostic truncated");
  });
});
