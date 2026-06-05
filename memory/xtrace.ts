/**
 * XTrace — Ally's memory layer.
 *
 * Assembles per-user context from Butterbase for pipeline injection and
 * writes plan adjustments back after sessions complete.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Goal {
  id: string;
  title: string;
  category: string;
  priority: number;
  status: string;
  estimated_hours: number;
  target_date?: string;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface GoalProgress {
  goal_id: string;
  progress_pct: number;
  session_duration_minutes: number;
  notes?: string;
  recorded_at: string;
}

export interface EmotionalState {
  mood: string;
  stress_level: number;
  energy_level: number;
  notes?: string;
  recorded_at: string;
}

export interface UserProfile {
  user_id: string;
  phone_number?: string;
  timezone: string;
  onboarding_complete: boolean;
  knowledge_context: Record<string, string>; // goal title → skill level
  preferences: {
    recharge?: string;
    coaching_style?: "detailed" | "brief";
    [key: string]: unknown;
  };
}

export interface ProgressSummary {
  goal_id: string;
  goal_title: string;
  latest_pct: number;
  weekly_minutes: number;
  momentum: "accelerating" | "steady" | "stalling" | "not_started";
  last_session?: string;
}

export type EmotionalTrend = "thriving" | "stable" | "stressed" | "burnout_risk";

export interface MemoryContext {
  // User identity
  user_id: string;
  timezone: string;
  coaching_style: string;
  recharge_activity: string;
  onboarding_complete: boolean;

  // Goals (sorted by priority)
  active_goals: string;         // formatted list for prompt injection
  goal_count: number;

  // Knowledge
  knowledge_summary: string;    // "For Python: intermediate. For fitness: beginner."

  // Progress
  progress_summary: string;     // per-goal momentum digest
  weekly_focus_goals: string;   // top 2 goals to focus on

  // Emotional
  emotional_trend: EmotionalTrend;
  avg_stress_last_7_days: number;
  emotional_summary: string;

  // Plan notes (auto-adjusted)
  plan_notes: string;

  // Raw data (for plan adjustment logic)
  _goals: Goal[];
  _progress: ProgressSummary[];
  _emotional_states: EmotionalState[];
}

export interface SessionMemory {
  session_type: "coach" | "checkin" | "prioritizer" | "onboarding" | "progress_tracker";
  summary: string;
  goal_ids_discussed?: string[];
  emotional_state?: Pick<EmotionalState, "mood" | "stress_level" | "energy_level">;
  plan_adjustments?: Record<string, number>; // goal_id → new priority
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function get<T>(
  url: string,
  accessToken: string,
  params: Record<string, string> = {}
): Promise<T[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${url}${qs ? `?${qs}` : ""}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${url} → ${res.status}: ${body}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : json.data ?? json.rows ?? [];
}

async function patch(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PATCH ${url} → ${res.status}: ${text}`);
  }
}

async function post(
  url: string,
  accessToken: string,
  body: Record<string, unknown>
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`POST ${url} → ${res.status}: ${text}`);
  }
}

function detectEmotionalTrend(states: EmotionalState[]): EmotionalTrend {
  if (states.length === 0) return "stable";
  const avg = states.reduce((s, e) => s + (e.stress_level ?? 5), 0) / states.length;
  const avgEnergy = states.reduce((s, e) => s + (e.energy_level ?? 5), 0) / states.length;
  if (avg >= 8 || (avg >= 7 && avgEnergy <= 3)) return "burnout_risk";
  if (avg >= 6) return "stressed";
  if (avg <= 3 && avgEnergy >= 7) return "thriving";
  return "stable";
}

function buildProgressSummaries(
  goals: Goal[],
  allProgress: GoalProgress[]
): ProgressSummary[] {
  const now = Date.now();
  const oneWeek = 7 * 24 * 60 * 60 * 1000;

  return goals.map((g) => {
    const records = allProgress
      .filter((p) => p.goal_id === g.id)
      .sort((a, b) => new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime());

    const latest_pct = records[0]?.progress_pct ?? 0;
    const last_session = records[0]?.recorded_at;

    const thisWeek = records.filter(
      (p) => now - new Date(p.recorded_at).getTime() < oneWeek
    );
    const lastWeek = records.filter((p) => {
      const age = now - new Date(p.recorded_at).getTime();
      return age >= oneWeek && age < 2 * oneWeek;
    });

    const weeklyMinutes = thisWeek.reduce((s, p) => s + (p.session_duration_minutes ?? 0), 0);
    const thisWeekPct = thisWeek[0]?.progress_pct ?? 0;
    const lastWeekPct = lastWeek[0]?.progress_pct ?? 0;

    let momentum: ProgressSummary["momentum"] = "not_started";
    if (records.length > 0) {
      if (thisWeekPct - lastWeekPct > 5) momentum = "accelerating";
      else if (thisWeek.length === 0) momentum = "stalling";
      else momentum = "steady";
    }

    return {
      goal_id: g.id,
      goal_title: g.title,
      latest_pct,
      weekly_minutes: weeklyMinutes,
      momentum,
      last_session,
    };
  });
}

function formatGoalList(goals: Goal[], progress: ProgressSummary[]): string {
  if (goals.length === 0) return "No active goals yet.";
  return goals
    .map((g, i) => {
      const p = progress.find((ps) => ps.goal_id === g.id);
      const pct = p ? `${p.latest_pct}%` : "0%";
      const mom = p ? ` [${p.momentum}]` : "";
      return `${i + 1}. ${g.title} (${g.category}) — ${pct} complete${mom}`;
    })
    .join("\n");
}

function formatKnowledge(knowledgeContext: Record<string, string>): string {
  const entries = Object.entries(knowledgeContext);
  if (entries.length === 0) return "No knowledge context recorded yet.";
  return entries.map(([goal, level]) => `${goal}: ${level}`).join(". ");
}

function formatEmotionalSummary(states: EmotionalState[], trend: EmotionalTrend): string {
  if (states.length === 0) return "No emotional data yet.";
  const latest = states[0];
  const moodList = states
    .slice(0, 5)
    .map((s) => s.mood)
    .join(", ");
  return `Recent moods: ${moodList}. Latest: stress ${latest.stress_level}/10, energy ${latest.energy_level}/10. Overall trend: ${trend}.`;
}

function buildPlanNotes(
  goals: Goal[],
  progress: ProgressSummary[],
  trend: EmotionalTrend,
  avgStress: number
): string {
  const notes: string[] = [];

  if (trend === "burnout_risk") {
    notes.push("User is showing burnout risk — reduce session targets by 25% and prioritise recovery activities before coaching.");
  } else if (trend === "stressed") {
    notes.push("User stress is elevated — open with emotional check-in before goal coaching.");
  } else if (trend === "thriving") {
    notes.push("User energy is high — great time to tackle stretch goals or increase weekly targets.");
  }

  const stalling = progress.filter((p) => p.momentum === "stalling" && p.latest_pct < 80);
  if (stalling.length > 0) {
    notes.push(
      `Stalling goals needing attention: ${stalling.map((p) => p.goal_title).join(", ")}.`
    );
  }

  const accelerating = progress.filter((p) => p.momentum === "accelerating");
  if (accelerating.length > 0) {
    notes.push(
      `Momentum goals to reinforce: ${accelerating.map((p) => p.goal_title).join(", ")}.`
    );
  }

  const nearComplete = goals.filter((g) => {
    const p = progress.find((ps) => ps.goal_id === g.id);
    return p && p.latest_pct >= 80;
  });
  if (nearComplete.length > 0) {
    notes.push(
      `Near completion (80%+): ${nearComplete.map((g) => g.title).join(", ")} — boost priority to close them out.`
    );
  }

  return notes.length > 0 ? notes.join(" ") : "No specific plan adjustments needed.";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetches all per-user memory from Butterbase and returns a structured
 * context object ready to be passed into question.addContext() in RocketRide.
 */
export async function getMemoryContext(
  userId: string,
  accessToken: string,
  apiUrl?: string
): Promise<MemoryContext> {
  const base = apiUrl ?? process.env.BUTTERBASE_API_URL!;

  const [profiles, goals, allProgress, recentEmotional] = await Promise.all([
    get<UserProfile>(
      `${base}/user_profiles`,
      accessToken,
      { user_id: `eq.${userId}` }
    ),
    get<Goal>(
      `${base}/goals`,
      accessToken,
      { user_id: `eq.${userId}`, status: "eq.active", order: "priority.asc" }
    ),
    get<GoalProgress>(
      `${base}/goal_progress`,
      accessToken,
      { user_id: `eq.${userId}`, order: "recorded_at.desc", limit: "50" }
    ),
    get<EmotionalState>(
      `${base}/emotional_states`,
      accessToken,
      { user_id: `eq.${userId}`, order: "recorded_at.desc", limit: "7" }
    ),
  ]);

  const profile = profiles[0] ?? {
    user_id: userId,
    timezone: "UTC",
    onboarding_complete: false,
    knowledge_context: {},
    preferences: {},
  };

  const progress = buildProgressSummaries(goals, allProgress);
  const trend = detectEmotionalTrend(recentEmotional);
  const avgStress =
    recentEmotional.length > 0
      ? recentEmotional.reduce((s, e) => s + (e.stress_level ?? 5), 0) /
        recentEmotional.length
      : 5;

  // Top 2 focus goals: highest priority + good momentum
  const focusGoals = [...goals]
    .sort((a, b) => {
      const pa = progress.find((p) => p.goal_id === a.id);
      const pb = progress.find((p) => p.goal_id === b.id);
      const scoreA = a.priority + (pa?.momentum === "accelerating" ? -1 : 0);
      const scoreB = b.priority + (pb?.momentum === "accelerating" ? -1 : 0);
      return scoreA - scoreB;
    })
    .slice(0, 2)
    .map((g) => g.title)
    .join(" and ");

  return {
    user_id: userId,
    timezone: profile.timezone ?? "UTC",
    coaching_style: profile.preferences?.coaching_style ?? "detailed",
    recharge_activity: profile.preferences?.recharge ?? "not set",
    onboarding_complete: profile.onboarding_complete,

    active_goals: formatGoalList(goals, progress),
    goal_count: goals.length,

    knowledge_summary: formatKnowledge(profile.knowledge_context ?? {}),

    progress_summary: progress
      .map(
        (p) =>
          `${p.goal_title}: ${p.latest_pct}% (${p.weekly_minutes}min this week, ${p.momentum})`
      )
      .join(" | "),
    weekly_focus_goals: focusGoals || "No goals set yet",

    emotional_trend: trend,
    avg_stress_last_7_days: Math.round(avgStress * 10) / 10,
    emotional_summary: formatEmotionalSummary(recentEmotional, trend),

    plan_notes: buildPlanNotes(goals, progress, trend, avgStress),

    _goals: goals,
    _progress: progress,
    _emotional_states: recentEmotional,
  };
}

/**
 * After a coaching or check-in session, saves a summary and applies any
 * priority adjustments to goals.
 */
export async function saveSessionMemory(
  userId: string,
  session: SessionMemory,
  accessToken: string,
  apiUrl?: string
): Promise<void> {
  const base = apiUrl ?? process.env.BUTTERBASE_API_URL!;

  await post(`${base}/ai_sessions`, accessToken, {
    user_id: userId,
    session_type: session.session_type,
    summary: session.summary,
    metadata: {
      goal_ids: session.goal_ids_discussed ?? [],
      emotional_state: session.emotional_state ?? null,
    },
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
  });

  if (session.emotional_state) {
    await post(`${base}/emotional_states`, accessToken, {
      user_id: userId,
      mood: session.emotional_state.mood,
      stress_level: session.emotional_state.stress_level,
      energy_level: session.emotional_state.energy_level,
      recorded_at: new Date().toISOString(),
    });
  }

  if (session.plan_adjustments) {
    await Promise.all(
      Object.entries(session.plan_adjustments).map(([goalId, newPriority]) =>
        patch(`${base}/goals?id=eq.${goalId}`, accessToken, {
          priority: newPriority,
          updated_at: new Date().toISOString(),
        })
      )
    );
  }
}
