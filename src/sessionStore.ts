import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

const SESSION_FILE = "./sessions.json";

function load(): Record<string, string> {
  if (!existsSync(SESSION_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function save(sessions: Record<string, string>): void {
  writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

export interface UserSession {
  userId: string;
  isNew: boolean;
}

// Returns a stable UUID for a given WhatsApp phone number.
// On first encounter: creates a new UUID, persists it locally and in Butterbase.
export async function getOrCreateUserId(phoneNumber: string): Promise<UserSession> {
  const sessions = load();
  if (sessions[phoneNumber]) {
    return { userId: sessions[phoneNumber], isNew: false };
  }

  const userId = randomUUID();
  sessions[phoneNumber] = userId;
  save(sessions);

  // Persist to Butterbase so the weekly cron can find this user's phone number
  try {
    await fetch(`${process.env.BUTTERBASE_API_URL}/user_profiles`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.BUTTERBASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId, phone_number: phoneNumber }),
    });
  } catch (err) {
    console.error("Failed to persist user_profile to Butterbase:", err);
  }

  console.log(`New user: ${phoneNumber} → ${userId}`);
  return { userId, isNew: true };
}
