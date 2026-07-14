/** Dependency-free RFC 9309 subset lifted from traverse/fetch/robots.ts. */
import type { RobotsRules } from "./internal-types.js";

export function productToken(userAgent: string): string {
  const first = userAgent.trim().split(/[\s/]+/)[0] ?? "";
  return first.toLowerCase();
}

interface RawGroup {
  agents: string[];
  rules: Array<{ path: string; allow: boolean }>;
}

export function parseRobots(text: string, userAgent: string): RobotsRules {
  const groups: RawGroup[] = [];
  let current: RawGroup | null = null;
  let sawRuleForCurrent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const index = line.indexOf(":");
    if (index === -1) continue;
    const field = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    if (field === "user-agent") {
      if (!current || sawRuleForCurrent) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRuleForCurrent = false;
      }
      if (value) current.agents.push(value.toLowerCase());
    } else if (field === "disallow" || field === "allow") {
      if (!current) continue;
      sawRuleForCurrent = true;
      if (field === "disallow" && value === "") continue;
      current.rules.push({ path: value, allow: field === "allow" });
    }
  }

  const token = productToken(userAgent);
  let best: RawGroup | undefined;
  let bestScore = -1;
  for (const group of groups) {
    for (const agent of group.agents) {
      let score = -1;
      if (agent === "*") score = 1;
      else if (agent === token) score = 3;
      else if (token.startsWith(agent) || agent.startsWith(token)) score = 2;
      if (score > bestScore) {
        bestScore = score;
        best = group;
      }
    }
  }
  return { rules: best ? best.rules : [] };
}

export function isPathAllowed(
  rules: RobotsRules,
  pathname: string,
): boolean {
  let decision = true;
  let matchLength = -1;
  for (const rule of rules.rules) {
    if (!rule.path || !pathname.startsWith(rule.path)) continue;
    const length = rule.path.length;
    if (length > matchLength || (length === matchLength && rule.allow)) {
      matchLength = length;
      decision = rule.allow;
    }
  }
  return decision;
}
