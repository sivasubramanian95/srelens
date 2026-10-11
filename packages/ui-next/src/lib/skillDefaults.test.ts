import { beforeEach, describe, expect, it, vi } from "vitest";
import { settingsStorage } from "@srelens/core";

const setSkillActive = vi.hoisted(() => vi.fn());
vi.mock("./agentRun", () => ({ setSkillActive }));
const listSkills = vi.hoisted(() => vi.fn());
vi.mock("@srelens/core", async (orig) => ({ ...(await orig<typeof import("@srelens/core")>()), listSkills }));

import {
  SKILL_DEFAULTS_KEY,
  __resetSkillDefaultsForTests,
  applySkillDefaults,
  estimateTokens,
  forgetSkillDefault,
  formatTokens,
  getSkillDefaults,
  isPreinstalled,
  parseSkillDefaults,
  setSkillDefault,
  skillIsOn,
} from "./skillDefaults";

const SHIPPED = { name: "oomkilled", description: "", builtin: true };
const COPIED = { name: "pending-pod", description: "", builtin: false, overridesBuiltin: true };
const OWN = { name: "team-runbook", description: "", builtin: false };

beforeEach(() => {
  settingsStorage.removeItem(SKILL_DEFAULTS_KEY);
  __resetSkillDefaultsForTests();
  setSkillActive.mockReset();
  listSkills.mockReset().mockResolvedValue([SHIPPED, COPIED, OWN]);
});

describe("parseSkillDefaults", () => {
  it("is no choices for nothing, for junk, and for the wrong shape", () => {
    for (const raw of [null, "", "{not json", '{"a":1}', '"text"', "7", "null", '{"on":"x","off":3}']) {
      expect(parseSkillDefaults(raw)).toEqual({ on: [], off: [] });
    }
  });

  it("keeps the names, once each, and drops what is not a name", () => {
    expect(
      parseSkillDefaults(
        JSON.stringify({ on: ["team-runbook", 3, "", null, "team-runbook"], off: ["oomkilled", {}, "oomkilled"] }),
      ),
    ).toEqual({ on: ["team-runbook"], off: ["oomkilled"] });
  });

  /** The shape this was first kept in recorded only what was on. */
  it("reads a bare list as the names turned on", () => {
    expect(parseSkillDefaults(JSON.stringify(["oomkilled", 3, "oomkilled", "pending-pod"]))).toEqual({
      on: ["oomkilled", "pending-pod"],
      off: [],
    });
  });

  it("reads a name that is both on and off as on", () => {
    expect(parseSkillDefaults(JSON.stringify({ on: ["oomkilled"], off: ["oomkilled", "pending-pod"] }))).toEqual({
      on: ["oomkilled"],
      off: ["pending-pod"],
    });
  });
});

describe("skillIsOn", () => {
  const untouched = { on: [], off: [] };

  it("has a preinstalled skill on until it is turned off", () => {
    expect(skillIsOn(SHIPPED, untouched)).toBe(true);
    expect(skillIsOn(SHIPPED, { on: [], off: ["oomkilled"] })).toBe(false);
  });

  it("treats the reader's copy of a preinstalled skill as the skill it replaces", () => {
    expect(isPreinstalled(COPIED)).toBe(true);
    expect(skillIsOn(COPIED, untouched)).toBe(true);
    expect(skillIsOn(COPIED, { on: [], off: ["pending-pod"] })).toBe(false);
  });

  it("has a skill the reader installed off until it is turned on", () => {
    expect(isPreinstalled(OWN)).toBe(false);
    expect(skillIsOn(OWN, untouched)).toBe(false);
    expect(skillIsOn(OWN, { on: ["team-runbook"], off: [] })).toBe(true);
  });
});

describe("the kept choices", () => {
  it("start as none", () => {
    expect(getSkillDefaults()).toEqual({ on: [], off: [] });
  });

  it("keep a skill turned on, across a restart", () => {
    setSkillDefault("team-runbook", true);
    __resetSkillDefaultsForTests();
    expect(getSkillDefaults()).toEqual({ on: ["team-runbook"], off: [] });
  });

  it("keep a skill turned off, across a restart", () => {
    setSkillDefault("oomkilled", false);
    __resetSkillDefaultsForTests();
    expect(getSkillDefaults()).toEqual({ on: [], off: ["oomkilled"] });
    expect(skillIsOn(SHIPPED, getSkillDefaults())).toBe(false);
  });

  it("move a skill from one side to the other, never leaving it on both", () => {
    setSkillDefault("oomkilled", false);
    setSkillDefault("team-runbook", true);
    setSkillDefault("oomkilled", true);
    setSkillDefault("team-runbook", false);
    __resetSkillDefaultsForTests();
    expect(getSkillDefaults()).toEqual({ on: ["oomkilled"], off: ["team-runbook"] });
  });

  it("apply to this window's next question at once, not only after a restart", () => {
    setSkillDefault("oomkilled", true);
    expect(setSkillActive).toHaveBeenCalledExactlyOnceWith("oomkilled", true);
    setSkillDefault("oomkilled", false);
    expect(setSkillActive).toHaveBeenLastCalledWith("oomkilled", false);
  });

  it("hold for the session when storage refuses the write", () => {
    const refuse = vi.spyOn(settingsStorage, "setItem").mockImplementation(() => {
      throw new Error("Settings backend is unavailable");
    });
    setSkillDefault("oomkilled", false);
    refuse.mockRestore();
    expect(getSkillDefaults()).toEqual({ on: [], off: ["oomkilled"] });
    expect(setSkillActive).toHaveBeenCalledWith("oomkilled", false);
  });

  it("forget a skill that is gone, whichever way it had been set, and turn it off here", () => {
    setSkillDefault("team-runbook", true);
    setSkillDefault("oomkilled", false);
    forgetSkillDefault("team-runbook");
    forgetSkillDefault("oomkilled");
    __resetSkillDefaultsForTests();
    expect(getSkillDefaults()).toEqual({ on: [], off: [] });
    expect(setSkillActive).toHaveBeenCalledWith("team-runbook", false);
  });
});

describe("applySkillDefaults", () => {
  const turnedOn = () => setSkillActive.mock.calls.map(([name, on]) => (on ? name : `!${name}`)).sort();

  it("turns the preinstalled skills on when nothing has been chosen, and leaves the reader's own off", async () => {
    await applySkillDefaults();
    expect(turnedOn()).toEqual(["oomkilled", "pending-pod"]);
  });

  it("leaves off a preinstalled skill the reader turned off", async () => {
    settingsStorage.setItem(SKILL_DEFAULTS_KEY, JSON.stringify({ on: [], off: ["oomkilled"] }));
    await applySkillDefaults();
    expect(turnedOn()).toEqual(["pending-pod"]);
  });

  it("turns on the reader's own skill that they turned on", async () => {
    settingsStorage.setItem(SKILL_DEFAULTS_KEY, JSON.stringify({ on: ["team-runbook"], off: ["pending-pod"] }));
    await applySkillDefaults();
    expect(turnedOn()).toEqual(["oomkilled", "team-runbook"]);
  });

  it("turns on the preinstalled skills for a choice kept in the first shape, which recorded none off", async () => {
    settingsStorage.setItem(SKILL_DEFAULTS_KEY, JSON.stringify(["team-runbook"]));
    await applySkillDefaults();
    expect(turnedOn()).toEqual(["oomkilled", "pending-pod", "team-runbook"]);
  });

  it("still turns on what was explicitly chosen when the skills cannot be listed", async () => {
    listSkills.mockRejectedValue(new Error("no skill store in this build"));
    settingsStorage.setItem(SKILL_DEFAULTS_KEY, JSON.stringify({ on: ["team-runbook"], off: [] }));
    await expect(applySkillDefaults()).resolves.toBeUndefined();
    expect(turnedOn()).toEqual(["team-runbook"]);
  });

  it("honours a switch thrown while the list was on its way", async () => {
    let answer: (skills: unknown[]) => void = () => {};
    listSkills.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const applied = applySkillDefaults();
    setSkillDefault("oomkilled", false);
    setSkillActive.mockClear();
    answer([SHIPPED, COPIED, OWN]);
    await applied;
    expect(turnedOn()).toEqual(["pending-pod"]);
  });
});

describe("estimateTokens and formatTokens", () => {
  it("counts a quarter of the characters, rounded up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("x".repeat(4000))).toBe(1000);
  });

  it("prints a figure for scale, rounded down", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1k");
    expect(formatTokens(3199)).toBe("3.1k");
    expect(formatTokens(14_783)).toBe("14k");
  });
});
