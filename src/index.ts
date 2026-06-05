import "dotenv/config";
import { Spectrum } from "spectrum-ts";
import { terminal } from "spectrum-ts/providers/terminal";
import { RocketRideClient, Question } from "rocketride";
import { getOrCreateUserId } from "./sessionStore.js";
import { getMemoryContext } from "../memory/xtrace.js";

const PIPELINES = {
  onboarding:       "./pipelines/onboarding.pipe",
  coach:            "./pipelines/ally_coach.pipe",
  prioritizer:      "./pipelines/goal_prioritizer.pipe",
  checkin:          "./pipelines/emotional_checkin.pipe",
  progress_tracker: "./pipelines/progress_tracker.pipe",
} as const;

type PipelineType = keyof typeof PIPELINES;

function routePipeline(text: string, isNew: boolean): PipelineType {
  if (isNew) return "onboarding";

  const t = text.toLowerCase().trim();

  if (/\breview\b|weekly review|progress update|how am i doing/.test(t)) {
    return "progress_tracker";
  }
  if (/stressed|burnout|burned.?out|exhausted|overwhelmed|anxious|sad|can't focus|feeling (bad|low|down|awful)/.test(t)) {
    return "checkin";
  }
  if (/prioritize|priority|learning.?path|where.?to.?start|what.?first|roadmap|plan.?my.?goals|which goal/.test(t)) {
    return "prioritizer";
  }
  return "coach";
}

async function getToken(
  client: RocketRideClient,
  type: PipelineType,
  userId: string
): Promise<string> {
  const token = `ally-${type}-${userId}`;
  await client.use({ filepath: PIPELINES[type], token, useExisting: true });
  return token;
}

async function main() {
  const rocketride = new RocketRideClient({
    auth: process.env.ROCKETRIDE_APIKEY!,
    uri:  process.env.ROCKETRIDE_URI!,
  });
  await rocketride.connect();
  console.log("RocketRide connected");

  const app = await Spectrum({
    providers: [terminal.config({})],
  });

  console.log("Ally is live — type your message below:");

  for await (const [space, message] of app.messages) {
    space.responding(async () => {
      try {
        if (message.content.type !== "text") {
          await message.reply("Hey! Send me a text message and I'll help you out.");
          return;
        }

        const from = message.sender.id ?? space.id;
        const text = message.content.text;

        if (!text.trim()) return;

        const { userId, isNew } = await getOrCreateUserId(from);
        const pipelineType = routePipeline(text, isNew);
        const token = await getToken(rocketride, pipelineType, userId);

        // Fetch full memory context (goals, progress, emotions, preferences)
        const memory = await getMemoryContext(
          userId,
          process.env.BUTTERBASE_SERVICE_KEY!,
          process.env.BUTTERBASE_API_URL!
        );

        const question = new Question();
        question.addQuestion(text);
        question.addContext({
          // Identity
          user_id: userId,
          phone_number: from,
          access_token: process.env.BUTTERBASE_SERVICE_KEY!,
          butterbase_api_url: process.env.BUTTERBASE_API_URL!,
          // Memory
          active_goals: memory.active_goals,
          goal_count: String(memory.goal_count),
          knowledge_summary: memory.knowledge_summary,
          progress_summary: memory.progress_summary,
          weekly_focus_goals: memory.weekly_focus_goals,
          emotional_trend: memory.emotional_trend,
          avg_stress: String(memory.avg_stress_last_7_days),
          emotional_summary: memory.emotional_summary,
          coaching_style: memory.coaching_style,
          recharge_activity: memory.recharge_activity,
          plan_notes: memory.plan_notes,
          onboarding_complete: String(memory.onboarding_complete),
        });

        const response = await rocketride.chat({ token, question });
        const answer = response.answers?.[0]
          ?? "I had trouble processing that — please try again in a moment.";

        await message.reply(answer);
      } catch (err) {
        console.error("Error handling message:", err);
        await message.reply("Something went wrong on my end. Please try again!");
      }
    });
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
