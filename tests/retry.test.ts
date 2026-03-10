import { describe, expect, it } from "vitest";

import { TemporaryIntegrationError } from "../src/utils/errors.js";
import { withRetry } from "../src/utils/retry.js";

describe("withRetry", () => {
  it("retries temporary errors and eventually succeeds", async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new TemporaryIntegrationError("temporary");
        }
        return "ok";
      },
      {
        retries: 3,
        delayMs: 1,
      },
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });
});
