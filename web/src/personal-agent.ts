import type { Profile } from "./api/types";

export const avatars = ["fox", "robin", "cat", "impo", "owl", "otter"] as const;

export function avatarURL(index?: number) {
  if (index === undefined || !Number.isInteger(index)) return undefined;
  const avatar = avatars[index];
  // Index 6 is a device-local photo; the profile API does not transfer its bytes.
  if (!avatar) return undefined;
  return avatar === "impo"
    ? "/app/assets/instant-mark.svg"
    : `/app/assets/avatar-${avatar}.webp`;
}

export function personalAgentName(profile?: Profile) {
  return profile?.assistantName?.trim() || "Your personal agent";
}
