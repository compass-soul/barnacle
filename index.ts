import { promises as fsp } from "node:fs";
import path from "node:path";
import os from "node:os";

const DEFAULT_PROJECTS_DIR = path.join(os.homedir(), ".openclaw", "planner", "projects");
const STATE_DIR = path.join(os.homedir(), ".openclaw", "planner", "state");

interface Project {
  id: string;
  goal: string;
  hypothesis: string | null;
  phase: string;
  nextAction: string | null;
  lastAction: { description: string; result: string; date: string } | null;
  reviewBy: string | null;
  verifications: any[];
  log: { date: string; action: string; result?: string }[];
  createdAt: string;
  updatedAt: string;
}

interface AuditSnapshot {
  timestamp: string;
  projects: Record<string, { updatedAt: string; phase: string; nextAction: string | null }>;
}

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

function auditProject(project: Project, lastSnapshot: AuditSnapshot | null): string[] {
  const issues: string[] = [];
  const now = Date.now();
  const updatedAt = new Date(project.updatedAt).getTime();
  const staleDays = Math.floor((now - updatedAt) / 86400000);

  if (staleDays > 2) issues.push(`⚠️ STALE — no updates in ${staleDays} days`);
  if (!project.nextAction?.trim()) issues.push("⚠️ NO NEXT ACTION");
  if (!project.hypothesis?.trim()) issues.push("⚠️ NO HYPOTHESIS");

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

  return issues;
}

function formatAuditReport(projects: Project[], allIssues: Map<string, string[]>): string {
  if (!projects.length) return "📋 **Planner Audit**\nNo projects found.";

  let report = "📋 **Planner Audit**\n\n";
  let totalIssues = 0;

  for (const proj of projects) {
    const issues = allIssues.get(proj.id) ?? [];
    totalIssues += issues.length;
    report += `${issues.length ? "🔴" : "✅"} **${proj.id}** (${proj.phase})\n`;
    if (proj.nextAction) report += `   Next: ${proj.nextAction}\n`;
    for (const issue of issues) report += `   ${issue}\n`;
    report += "\n";
  }

  report += totalIssues
    ? `_${totalIssues} issue(s) found._`
    : "_All projects on track._";

  return report;
}

const json = (payload: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
});

export default function register(api: any) {
  const logger = api.logger ?? console;

  function getConfig() {
    const cfg = api.config?.plugins?.entries?.["barnacle"]?.config ?? {};
    return {
      projectsDir: cfg.projectsDir || DEFAULT_PROJECTS_DIR,
      auditIntervalMinutes: cfg.auditIntervalMinutes || 30,
      reportChannel: cfg.reportChannel || null,
      reportTarget: cfg.reportTarget || null,
    };
  }

  // ── Agent tool ────────────────────────────────────────────────

  api.registerTool?.({
    name: "barnacle",
    description:
      "Structured planning that survives compaction. Track goals, hypotheses, actions, and results. Independently audited. Actions: create, update, get, list.",
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
              },
            },
            reviewBy: { type: "string" },
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
    description: "Show project status and audit results",
    handler: async () => {
      const cfg = getConfig();
      const projects = await listProjects(cfg.projectsDir);
      const lastSnapshot = await readJson<AuditSnapshot>(path.join(STATE_DIR, "last-audit.json"));
      const allIssues = new Map<string, string[]>();
      for (const proj of projects) {
        allIssues.set(proj.id, auditProject(proj, lastSnapshot));
      }
      return { text: formatAuditReport(projects, allIssues) };
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

      // Save report if issues found
      if (totalIssues > 0) {
        await writeJson(path.join(STATE_DIR, "last-report.json"), {
          timestamp: new Date().toISOString(),
          report: formatAuditReport(projects, allIssues),
          totalIssues,
          projectCount: projects.length,
        });
      }

      logger.info?.(`[barnacle] Audit: ${projects.length} projects, ${totalIssues} issues`);
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
