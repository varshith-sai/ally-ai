import { RocketRideClient } from "rocketride";
import { existsSync } from "fs";

const REQUIRED_VARS = [
  "ROCKETRIDE_URI",
  "ROCKETRIDE_APIKEY",
  "ROCKETRIDE_ANTHROPIC_KEY",
  "ROCKETRIDE_BUTTERBASE_API_URL",
  "PROJECT_ID",
  "PROJECT_SECRET",
  "BUTTERBASE_SERVICE_KEY",
  "BUTTERBASE_API_URL",
];

const PIPELINE_FILES = [
  "./pipelines/onboarding.pipe",
  "./pipelines/ally_coach.pipe",
  "./pipelines/goal_prioritizer.pipe",
  "./pipelines/emotional_checkin.pipe",
  "./pipelines/progress_tracker.pipe",
];

async function check() {
  console.log("--- Ally setup check ---\n");

  // 1. Env vars
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.error("✗ Missing environment variables:", missing.join(", "));
    process.exit(1);
  }
  console.log("✓ All environment variables present");

  // 2. RocketRide connectivity
  const client = new RocketRideClient();
  await client.connect();
  await client.ping();
  await client.disconnect();
  console.log("✓ RocketRide server reachable");

  // 3. Pipeline files
  for (const p of PIPELINE_FILES) {
    if (!existsSync(p)) {
      console.error(`✗ Missing pipeline file: ${p}`);
      process.exit(1);
    }
  }
  console.log(`✓ All ${PIPELINE_FILES.length} pipeline files present`);

  // 4. Butterbase API reachable
  const res = await fetch(`${process.env.BUTTERBASE_API_URL}/user_profiles?limit=1`, {
    headers: { Authorization: `Bearer ${process.env.BUTTERBASE_SERVICE_KEY}` },
  });
  if (!res.ok) {
    console.error("✗ Butterbase API unreachable:", res.status, await res.text());
    process.exit(1);
  }
  console.log("✓ Butterbase API reachable");

  console.log("\nAll checks passed. Run `npm start` to launch Ally.");
}

check().catch((err) => {
  console.error("✗ Check failed:", (err as Error).message);
  process.exit(1);
});
