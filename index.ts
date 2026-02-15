import { promises as fsp } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import os from "node:os";

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".openclaw", "planner", "projects");
const STATE_DIR = path.join(os.homedir(), ".openclaw", "planner", "state");

// ── Types ───────────────────────────────────────────────────────

interface Evidence {
  kind: "commit" | "url" | "file" | "command";
  value: string;
  repo?: string;
  expect?: string;
  verified?: boolean;
  verifiedAt?: string;
  verifyError?: string;
}

interface LastAction {
  description: string;
  result: string;
  date: string;
  evidence?: Evidence[];
}

interface KPI {
  name: string;
  metric: string;
  baseline: string | null;
  target: string | null;
  current: string | null;
  measuredAt: string | null;
}

interface Project {
  id: string;
  goal: string;
  hypothesis: string | null;
  phase: string;
  nextAction: string | null;
  lastAction: LastAction | null;
  reviewBy: string | null;
  limitations: string[];
  outcome: string | null;
  outcomeReached: boolean | null;
  kpis: KPI[];
  verifications: { date: string; passed: number; failed: number; details: string[] }[];
  log: { date: string; action: string; result?: string }[];
  createdAt: string;
  updatedAt: string;
}

interface AuditSnapshot {
  timestamp: string;
  projects: Record<string, { updatedAt: string; phase: string; nextAction: string | null }>;
}

// ── Helpers ─────────────────────────────────────────────────────

async function ensureDir(dir: string) {
  await fsp.mkdir(dir, { recursive: true });
}

async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

async function writeJson(filePath: string, value: any) {
  await ensureDir(path.dirname(filePath));
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function execPromise(cmd: string, args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts?.timeout ?? 10000, cwd: opts?.cwd }, (err, stdout, stderr) => {
      resolve({ stdout: stdout?.toString() ?? "", stderr: stderr?.toString() ?? "", code: err ? (err as any).code ?? 1 : 0 });
    });
  });
}

// ── Evidence Verification ───────────────────────────────────────

async function verifyEvidence(ev: Evidence): Promise<{ passed: boolean; detail: string }> {
  try {
    switch (ev.kind) {
      case "commit": {
        const repo = ev.repo || ".";
        const { stdout, code } = await execPromise("git", ["log", "--oneline", "-1", ev.value], { cwd: repo });
        if (code !== 0 || !stdout.trim()) return { passed: false, detail: `Commit ${ev.value.slice(0, 8)} not found in ${repo}` };
        return { passed: true, detail: `Commit ${ev.value.slice(0, 8)} verified: ${stdout.trim()}` };
      }
      case "url": {
        const { code } = await execPromise("curl", ["-sfIL", "--max-time", "5", "-o", "/dev/null", "-w", "%{http_code}", ev.value]);
        if (code !== 0) return { passed: false, detail: `URL unreachable: ${ev.value}` };
        return { passed: true, detail: `URL reachable: ${ev.value}` };
      }
      case "file": {
        try {
          await fsp.access(ev.value);
          return { passed: true, detail: `File exists: ${ev.value}` };
        } catch {
          return { passed: false, detail: `File missing: ${ev.value}` };
        }
      }
      case "command": {
        const parts = ev.value.split(" ");
        const { stdout, code } = await execPromise(parts[0], parts.slice(1));
        if (code !== 0) return { passed: false, detail: `Command failed: ${ev.value}` };
        if (ev.expect && !stdout.includes(ev.expect)) {
          return { passed: false, detail: `Command output missing expected "${ev.expect}"` };
        }
        return { passed: true, detail: `Command passed: ${ev.value}` };
      }
      default:
        return { passed: false, detail: `Unknown evidence kind: ${(ev as any).kind}` };
    }
  } catch (err: any) {
    return { passed: false, detail: `Verification error: ${err.message}` };
  }
}

async function verifyProjectEvidence(project: Project): Promise<{ passed: number; failed: number; details: string[] }> {
  const evidence = project.lastAction?.evidence;
  if (!evidence?.length) return { passed: 0, failed: 0, details: [] };

  let passed = 0, failed = 0;
  const details: string[] = [];

  for (const ev of evidence) {
    const result = await verifyEvidence(ev);
    ev.verified = result.passed;
    ev.verifiedAt = new Date().toISOString();
    if (!result.passed) ev.verifyError = result.detail;
    if (result.passed) passed++; else failed++;
    details.push(`${result.passed ? "✅" : "❌"} ${result.detail}`);
  }

  return { passed, failed, details };
}

// ── Project I/O ─────────────────────────────────────────────────

async function listProjects(projectsDir: string): Promise<Project[]> {
  await ensureDir(projectsDir);
  const files = await fsp.readdir(projectsDir);
  const projects: Project[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const proj = await readJson<Project>(path.join(projectsDir, f));
    if (proj) projects.push(proj);
  }
  return projects;
}

// ── Audit ───────────────────────────────────────────────────────

function auditProject(project: Project, lastSnapshot: AuditSnapshot | null): string[] {
  const issues: string[] = [];
  const now = Date.now();
  const updatedAt = new Date(project.updatedAt).getTime();
  const staleDays = Math.floor((now - updatedAt) / 86400000);

  if (staleDays > 2) issues.push(`⚠️ STALE — no updates in ${staleDays} days`);
  if (!project.nextAction?.trim()) issues.push("⚠️ NO NEXT ACTION");
  if (!project.hypothesis?.trim()) issues.push("⚠️ NO HYPOTHESIS — working without knowing what you're testing");
  if (!project.limitations?.length) issues.push("⚠️ NO LIMITATIONS — every project has constraints, document them");
  if (!project.outcome?.trim()) issues.push("⚠️ NO OUTCOME — what does success look like?");
  if (!project.kpis?.length) issues.push("⚠️ NO KPIs — how will you measure progress?");

  if (project.reviewBy) {
    const reviewDate = new Date(project.reviewBy).getTime();
    if (reviewDate < now) issues.push(`⚠️ OVERDUE REVIEW — was due ${project.reviewBy}`);
  }

  if (lastSnapshot?.projects[project.id]) {
    const prev = lastSnapshot.projects[project.id];
    if (prev.updatedAt === project.updatedAt && prev.nextAction === project.nextAction) {
      issues.push("⚠️ NO PROGRESS since last audit");
    }
  }

  if (!project.log?.length) issues.push("⚠️ EMPTY LOG");
  if (project.lastAction && !project.lastAction.result?.trim()) {
    issues.push("⚠️ LAST ACTION HAS NO RESULT");
  }

  // Evidence checks
  if (project.lastAction && !project.lastAction.evidence?.length) {
    issues.push("⚠️ NO EVIDENCE — last action has no verifiable proof");
  }
  const failedEvidence = project.lastAction?.evidence?.filter((e) => e.verified === false);
  if (failedEvidence?.length) {
    issues.push(`🔴 EVIDENCE FAILED — ${failedEvidence.length} check(s) did not pass`);
  }

  return issues;
}

function formatAuditReport(projects: Project[], allIssues: Map<string, string[]>, beadsStatus?: string): string {
  let report = "🦀 **Barnacle Audit**\n\n";

  if (beadsStatus) {
    report += `📋 **Beads:** ${beadsStatus}\n\n`;
  }

  if (!projects.length) {
    report += "No tracked hypotheses.\n";
    return report;
  }

  let totalIssues = 0;

  for (const proj of projects) {
    const issues = allIssues.get(proj.id) ?? [];
    totalIssues += issues.length;
    report += `${issues.length ? "🔴" : "✅"} **${proj.id}** (${proj.phase})\n`;
    report += `   Goal: ${proj.goal}\n`;
    if (proj.hypothesis) report += `   Hypothesis: ${proj.hypothesis}\n`;
    if (proj.nextAction) report += `   Next: ${proj.nextAction}\n`;
    for (const issue of issues) report += `   ${issue}\n`;
    report += "\n";
  }

  report += totalIssues
    ? `_${totalIssues} issue(s) found._`
    : "_All hypotheses on track._";

  return report;
}

// ── JSON response helper ────────────────────────────────────────

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

// ── Plugin ──────────────────────────────────────────────────────

export default function register(api: any) {
  const logger = api.logger ?? console;

  function getConfig() {
    const cfg = api.config?.plugins?.entries?.["barnacle"]?.config ?? {};
    return {
      projectsDir: cfg.projectsDir || DEFAULT_PROJECTS_DIR,
      auditIntervalMinutes: cfg.auditIntervalMinutes || 30,
    };
  }

  // ── Agent tool ──────────────────────────────────────────────

  api.registerTool?.({
    name: "barnacle",
    description:
      "Structured planning that survives compaction. Track goals, hypotheses, actions, and results. Independently audited. Actions: create, update, get, list. Include evidence in lastAction for automatic verification (commit hashes, URLs, file paths, commands).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "update", "get", "list"] },
        id: { type: "string", description: "Project ID (kebab-case)" },
        data: {
          type: "object",
          properties: {
            goal: { type: "string" },
            hypothesis: { type: "string" },
            phase: { type: "string" },
            nextAction: { type: "string" },
            lastAction: {
              type: "object",
              properties: {
                description: { type: "string" },
                result: { type: "string" },
                date: { type: "string" },
                evidence: {
                  type: "array",
                  description: "Verifiable proof. Each item: {kind: commit|url|file|command, value: string, repo?: string, expect?: string}",
                  items: {
                    type: "object",
                    properties: {
                      kind: { type: "string", enum: ["commit", "url", "file", "command"] },
                      value: { type: "string" },
                      repo: { type: "string" },
                      expect: { type: "string" },
                    },
                    required: ["kind", "value"],
                  },
                },
              },
            },
            reviewBy: { type: "string" },
            limitations: {
              type: "array",
              description: "Known limitations of this project — what it can't do, architectural constraints, honest grounding",
              items: { type: "string" },
            },
            outcome: { type: "string", description: "What success looks like — specific, measurable" },
            outcomeReached: { type: "boolean", description: "Has the outcome been achieved?" },
            kpis: {
              type: "array",
              description: "Key metrics to track progress. Each: {name, metric, baseline, target, current, measuredAt}",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  metric: { type: "string", description: "How to measure this (command, manual check, etc.)" },
                  baseline: { type: "string" },
                  target: { type: "string" },
                  current: { type: "string" },
                  measuredAt: { type: "string" },
                },
                required: ["name", "metric"],
              },
            },
            log: {
              type: "object",
              properties: {
                action: { type: "string" },
                result: { type: "string" },
              },
            },
          },
        },
      },
      required: ["action"],
    },
    execute: async (_id: string, params: { action: string; id?: string; data?: any }) => {
      const { action, id, data } = params;
      const cfg = getConfig();
      await ensureDir(cfg.projectsDir);

      if (action === "list") {
        const projects = await listProjects(cfg.projectsDir);
        return json({
          projects: projects.map((p) => ({
            id: p.id,
            goal: p.goal,
            hypothesis: p.hypothesis,
            phase: p.phase,
            nextAction: p.nextAction,
            updatedAt: p.updatedAt,
            issueCount: auditProject(p, null).length,
          })),
        });
      }

      if (action === "get") {
        if (!id) return json({ error: "id required" });
        const proj = await readJson<Project>(path.join(cfg.projectsDir, `${id}.json`));
        if (!proj) return json({ error: `Project '${id}' not found` });
        return json({ project: proj, issues: auditProject(proj, null) });
      }

      if (action === "create") {
        if (!id) return json({ error: "id required" });
        if (!data?.goal) return json({ error: "data.goal required" });
        const now = new Date().toISOString();
        const proj: Project = {
          id,
          goal: data.goal,
          hypothesis: data.hypothesis || null,
          phase: data.phase || "research",
          nextAction: data.nextAction || null,
          lastAction: null,
          reviewBy: data.reviewBy || null,
          limitations: data.limitations || [],
          outcome: data.outcome || null,
          outcomeReached: null,
          kpis: data.kpis || [],
          verifications: [],
          log: [{ date: now, action: data.log?.action || "Project created" }],
          createdAt: now,
          updatedAt: now,
        };
        await writeJson(path.join(cfg.projectsDir, `${id}.json`), proj);
        return json({ created: true, project: proj });
      }

      if (action === "update") {
        if (!id) return json({ error: "id required" });
        const filePath = path.join(cfg.projectsDir, `${id}.json`);
        const proj = await readJson<Project>(filePath);
        if (!proj) return json({ error: `Project '${id}' not found` });

        const now = new Date().toISOString();
        if (data?.goal) proj.goal = data.goal;
        if (data?.hypothesis) proj.hypothesis = data.hypothesis;
        if (data?.phase) proj.phase = data.phase;
        if (data?.nextAction) proj.nextAction = data.nextAction;
        if (data?.reviewBy) proj.reviewBy = data.reviewBy;
        if (data?.limitations) proj.limitations = data.limitations;
        if (data?.outcome) proj.outcome = data.outcome;
        if (data?.outcomeReached !== undefined) proj.outcomeReached = data.outcomeReached;
        if (data?.kpis) proj.kpis = data.kpis;
        if (data?.lastAction) {
          proj.lastAction = { ...data.lastAction, date: data.lastAction.date || now };
        }
        if (data?.log) {
          proj.log.push({ date: now, action: data.log.action, result: data.log.result });
        }
        proj.updatedAt = now;
        await writeJson(filePath, proj);
        return json({ updated: true, project: proj });
      }

      return json({ error: `Unknown action: ${action}` });
    },
  });

  // ── Slash command ─────────────────────────────────────────────

  api.registerCommand?.({
    name: "planner",
    description: "Show hypothesis tracking and audit results",
    handler: async () => {
      const cfg = getConfig();
      const projects = await listProjects(cfg.projectsDir);
      const lastSnapshot = await readJson<AuditSnapshot>(path.join(STATE_DIR, "last-audit.json"));
      const allIssues = new Map<string, string[]>();
      for (const proj of projects) {
        allIssues.set(proj.id, auditProject(proj, lastSnapshot));
      }

      // Check Beads status if available
      let beadsStatus: string | undefined;
      try {
        const { stdout } = await execPromise("bd", ["ready", "--json"], { timeout: 5000 });
        const ready = JSON.parse(stdout || "[]");
        beadsStatus = `${ready.length} task(s) ready`;
      } catch { /* beads not installed or not initialized */ }

      return { text: formatAuditReport(projects, allIssues, beadsStatus) };
    },
  });

  // ── Background auditor service ────────────────────────────────

  let auditTimer: ReturnType<typeof setInterval> | null = null;

  async function runAudit() {
    try {
      const cfg = getConfig();
      const projects = await listProjects(cfg.projectsDir);
      if (!projects.length) return;

      const lastSnapshot = await readJson<AuditSnapshot>(path.join(STATE_DIR, "last-audit.json"));
      const allIssues = new Map<string, string[]>();
      let totalIssues = 0;

      for (const proj of projects) {
        // Verify evidence against reality
        if (proj.lastAction?.evidence?.length) {
          const vResult = await verifyProjectEvidence(proj);
          proj.verifications.push({
            date: new Date().toISOString(),
            passed: vResult.passed,
            failed: vResult.failed,
            details: vResult.details,
          });
          await writeJson(path.join(cfg.projectsDir, `${proj.id}.json`), proj);
          if (vResult.failed > 0) {
            logger.warn?.(`[barnacle] ${proj.id}: ${vResult.failed} evidence check(s) FAILED`);
          }
        }

        const issues = auditProject(proj, lastSnapshot);
        allIssues.set(proj.id, issues);
        totalIssues += issues.length;
      }

      // Save snapshot
      await writeJson(path.join(STATE_DIR, "last-audit.json"), {
        timestamp: new Date().toISOString(),
        projects: Object.fromEntries(
          projects.map((p) => [p.id, { updatedAt: p.updatedAt, phase: p.phase, nextAction: p.nextAction }])
        ),
      } as AuditSnapshot);

      // Always write report (even if no issues — absence of issues is data)
      await writeJson(path.join(STATE_DIR, "last-report.json"), {
        timestamp: new Date().toISOString(),
        report: formatAuditReport(projects, allIssues),
        totalIssues,
        projectCount: projects.length,
      });

      // Write alert file when evidence fails or critical issues found
      // External cron/heartbeat reads this and escalates to human
      const criticalIssues = [...allIssues.values()].flat().filter(i => i.startsWith("🔴"));
      if (criticalIssues.length > 0) {
        await writeJson(path.join(STATE_DIR, "alert.json"), {
          timestamp: new Date().toISOString(),
          level: "critical",
          issues: criticalIssues,
          report: formatAuditReport(projects, allIssues),
        });
        logger.warn?.(`[barnacle] 🔴 CRITICAL: ${criticalIssues.length} evidence failure(s) — alert written`);
      } else {
        // Clear alert if no critical issues
        try { await fsp.unlink(path.join(STATE_DIR, "alert.json")); } catch {}
      }

      logger.info?.(`[barnacle] Audit: ${projects.length} hypotheses, ${totalIssues} issues`);
    } catch (err) {
      logger.error?.("[barnacle] Audit error:", err);
    }
  }

  api.registerService?.({
    id: "barnacle-auditor",
    start: () => {
      const cfg = getConfig();
      const ms = cfg.auditIntervalMinutes * 60 * 1000;
      logger.info?.(`[barnacle] Auditor starting (every ${cfg.auditIntervalMinutes}m)`);
      runAudit();
      auditTimer = setInterval(runAudit, ms);
    },
    stop: () => {
      if (auditTimer) clearInterval(auditTimer);
      logger.info?.("[barnacle] Auditor stopped");
    },
  });

  // ── Gateway RPC ───────────────────────────────────────────────

  api.registerGatewayMethod?.("planner.status", async ({ respond }: any) => {
    const cfg = getConfig();
    const projects = await listProjects(cfg.projectsDir);
    const lastSnapshot = await readJson<AuditSnapshot>(path.join(STATE_DIR, "last-audit.json"));
    const allIssues = new Map<string, string[]>();
    for (const proj of projects) {
      allIssues.set(proj.id, auditProject(proj, lastSnapshot));
    }
    respond(true, {
      projects: projects.map((p) => ({
        id: p.id,
        phase: p.phase,
        hypothesis: p.hypothesis,
        nextAction: p.nextAction,
        issues: allIssues.get(p.id) ?? [],
      })),
      lastAudit: lastSnapshot?.timestamp ?? null,
    });
  });

  api.registerGatewayMethod?.("planner.audit", async ({ respond }: any) => {
    await runAudit();
    respond(true, { ok: true });
  });
}
