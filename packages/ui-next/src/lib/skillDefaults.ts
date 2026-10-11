import { useSyncExternalStore } from "react";
import { listSkills, settingsStorage, type SkillMeta } from "@srelens/core";
import { setSkillActive } from "./agentRun";

/**
 * Which skills are on for every new conversation (#851).
 *
 * A skill could only be switched on for the run open right now — from the
 * agent screen's rail or the composer's `/` menu — and that choice is never
 * kept: each launch started with none. A reader who always wants the same two
 * skills picked them again every morning. This is the kept choice. It seeds
 * the window's active set when the window starts ({@link applySkillDefaults}),
 * and the per-run switches still turn a skill off or on for the moment without
 * touching it.
 *
 * A preinstalled skill is on until the reader turns it off; one they installed
 * is off until they turn it on. So what is kept is the choices made, in both
 * directions, and not a list of what is on: a list of what is on cannot tell
 * "turned off" from "never touched", and every preinstalled skill would come
 * back on at the next launch.
 */
export const SKILL_DEFAULTS_KEY = "srelens.next.skillDefaults";

/** The choices the reader has made: names turned on, and names turned off. */
export interface SkillDefaults {
  readonly on: readonly string[];
  readonly off: readonly string[];
}

const NONE: SkillDefaults = { on: [], off: [] };

function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((name): name is string => typeof name === "string" && name !== ""))];
}

/**
 * A stored document as the choices in it; anything else is no choices. A bare
 * list is the shape this was first kept in, when only "on" was recorded.
 */
export function parseSkillDefaults(raw: string | null): SkillDefaults {
  if (!raw) return NONE;
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return NONE;
  }
  if (Array.isArray(doc)) return { on: names(doc), off: [] };
  if (typeof doc !== "object" || doc === null) return NONE;
  const { on, off } = doc as { on?: unknown; off?: unknown };
  const turnedOn = names(on);
  // A name in both is a document nobody here wrote; "on" wins, as the choice
  // that costs the reader nothing to notice and undo.
  return { on: turnedOn, off: names(off).filter((name) => !turnedOn.includes(name)) };
}

/** Whether a skill ships with the app — as shipped, or under the reader's copy of it. */
export function isPreinstalled(skill: Pick<SkillMeta, "builtin" | "overridesBuiltin">): boolean {
  return skill.builtin === true || skill.overridesBuiltin === true;
}

/** Whether a skill is on for every new conversation, given the choices made. */
export function skillIsOn(
  skill: Pick<SkillMeta, "name" | "builtin" | "overridesBuiltin">,
  choices: SkillDefaults,
): boolean {
  if (choices.on.includes(skill.name)) return true;
  if (choices.off.includes(skill.name)) return false;
  return isPreinstalled(skill);
}

let defaults: SkillDefaults | null = null;
const listeners = new Set<() => void>();

function read(): SkillDefaults {
  if (defaults === null) {
    try {
      defaults = parseSkillDefaults(settingsStorage.getItem(SKILL_DEFAULTS_KEY));
    } catch {
      defaults = NONE;
    }
  }
  return defaults;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function keep(next: SkillDefaults): void {
  defaults = next;
  try {
    settingsStorage.setItem(SKILL_DEFAULTS_KEY, JSON.stringify(next));
  } catch {
    // Storage is unavailable: the choice holds for this session.
  }
  for (const listener of listeners) listener();
}

export function getSkillDefaults(): SkillDefaults {
  return read();
}

export function useSkillDefaults(): SkillDefaults {
  return useSyncExternalStore(subscribe, read, read);
}

/**
 * Turn a skill on or off for every new conversation — and for this window's
 * next question too, so the switch does what it says without a restart.
 */
export function setSkillDefault(name: string, on: boolean): void {
  const current = read();
  const without = (list: readonly string[]) => list.filter((n) => n !== name);
  keep(
    on
      ? { on: [...without(current.on), name], off: without(current.off) }
      : { on: without(current.on), off: [...without(current.off), name] },
  );
  setSkillActive(name, on);
}

/**
 * Drop whatever was chosen for a skill that is gone, and turn it off for this
 * window. Not the same as turning it off: a skill installed later under the
 * same name starts as any new one does, not as one already refused.
 */
export function forgetSkillDefault(name: string): void {
  const current = read();
  if (current.on.includes(name) || current.off.includes(name)) {
    keep({ on: current.on.filter((n) => n !== name), off: current.off.filter((n) => n !== name) });
  }
  setSkillActive(name, false);
}

/**
 * Start the window with its skills on: the preinstalled ones the reader has
 * not turned off, and their own that they turned on. Once, after boot, when
 * settings are readable.
 *
 * Which skills are preinstalled is the backend's to say, so this asks it. If
 * it cannot answer — the web build has no skill store — the names the reader
 * turned on are still applied: a name whose skill is missing is harmless, the
 * agent run skips a skill it cannot load.
 */
export async function applySkillDefaults(): Promise<void> {
  let installed: SkillMeta[] = [];
  try {
    installed = await listSkills();
  } catch {
    // No list: only what was explicitly turned on, below.
  }
  // Read after the wait, so a switch thrown while the list was on its way is
  // the one that holds.
  const choices = read();
  const on = new Set(choices.on);
  for (const skill of installed) if (skillIsOn(skill, choices)) on.add(skill.name);
  for (const name of on) setSkillActive(name, true);
}

/**
 * About how many tokens a text costs a model: a quarter of its characters,
 * rounded up. An estimate for sizing a choice, not a bill — every figure drawn
 * from it is marked as approximate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** `412`, `3.1k`, `14k` — a figure for scale, rounded down. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(Math.floor(n / 100) / 10).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.floor(n / 1000)}k`;
}

/** Forget the in-memory copy so a test starts from storage. */
export function __resetSkillDefaultsForTests(): void {
  defaults = null;
  listeners.clear();
}
