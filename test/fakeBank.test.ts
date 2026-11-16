import { describe, it, expect } from "vitest";
import { FakeBank } from "../src/bank/fakeBank.js";
import { rngFromSeed } from "../harness/generate.js";

describe("FakeBank", () => {
  describe("idempotency", () => {
    it("replays the same outcome on a repeated send with the same key", async () => {
      const bank = new FakeBank(rngFromSeed(1));
      const first = await bank.send("key-1", 1000, "routing:1");
      const second = await bank.send("key-1", 1000, "routing:1");
      expect(second.type).toBe(first.type);
    });

    it("produces independent outcomes for different keys", async () => {
      // Two keys from the same bank should not interfere
      const bank = new FakeBank(rngFromSeed(99));
      await bank.send("key-a", 1000, "routing:1");
      await bank.send("key-b", 2000, "routing:2");
      // Both keys appear in settled or not  -  just verify they're tracked independently
      const settled = bank.getSettledKeys();
      // keys are independent entries
      if (settled.has("key-a")) expect(settled.get("key-a")).toBe(1000);
      if (settled.has("key-b")) expect(settled.get("key-b")).toBe(2000);
    });
  });

  describe("determinism", () => {
    it("produces identical outcomes for the same seed", async () => {
      const bank1 = new FakeBank(rngFromSeed(42));
      const bank2 = new FakeBank(rngFromSeed(42));
      const r1 = await bank1.send("k", 500, "r");
      const r2 = await bank2.send("k", 500, "r");
      expect(r1.type).toBe(r2.type);
    });
  });

  describe("status query disabled", () => {
    it("always returns NOT_FOUND when statusQueryEnabled=false", async () => {
      const bank = new FakeBank(rngFromSeed(7), { statusQueryEnabled: false });
      await bank.send("key-x", 100, "r");
      const status = await bank.getStatus("key-x");
      expect(status.type).toBe("NOT_FOUND");
    });
  });

  describe("getSettledKeys", () => {
    it("includes ACCEPTED keys", async () => {
      // Force 100% accept rate
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 0,
      });
      await bank.send("key-accept", 1234, "r");
      expect(bank.getSettledKeys().get("key-accept")).toBe(1234);
    });

    it("excludes permanently rejected keys", async () => {
      // Force 100% permanent reject
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 1,
        transientRejectRate: 0,
        timeoutRate: 0,
      });
      await bank.send("key-reject", 1000, "r");
      expect(bank.getSettledKeys().has("key-reject")).toBe(false);
    });

    it("includes async-confirmed timeout keys", async () => {
      // Force 100% timeout, 100% async confirm
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 1,
        asyncConfirmRate: 1,
      });
      await bank.send("key-timeout", 777, "r");
      expect(bank.getSettledKeys().get("key-timeout")).toBe(777);
    });

    it("excludes async-failed timeout keys", async () => {
      // Force 100% timeout, 0% async confirm
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 1,
        asyncConfirmRate: 0,
      });
      await bank.send("key-timeout-fail", 500, "r");
      expect(bank.getSettledKeys().has("key-timeout-fail")).toBe(false);
    });
  });

  describe("getStatus", () => {
    it("returns CONFIRMED for an accepted key", async () => {
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 0,
        timeoutRate: 0,
        statusTimeoutRate: 0,
      });
      await bank.send("k", 100, "r");
      const status = await bank.getStatus("k");
      expect(status.type).toBe("CONFIRMED");
    });

    it("returns NOT_FOUND for a transient-rejected key", async () => {
      const bank = new FakeBank(rngFromSeed(1), {
        permanentRejectRate: 0,
        transientRejectRate: 1,
        timeoutRate: 0,
        statusTimeoutRate: 0,
      });
      await bank.send("k", 100, "r");
      const status = await bank.getStatus("k");
      // Transient reject = bank never processed it
      expect(status.type).toBe("NOT_FOUND");
    });

    it("returns NOT_FOUND for an unknown key", async () => {
      const bank = new FakeBank(rngFromSeed(1), { statusTimeoutRate: 0 });
      const status = await bank.getStatus("never-sent");
      expect(status.type).toBe("NOT_FOUND");
    });
  });
});
