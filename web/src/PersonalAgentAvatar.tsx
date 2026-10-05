import { Avatar } from "@astryxdesign/core/Avatar";
import type { Profile } from "./api/types";
import { avatarURL, personalAgentName } from "./personal-agent";

export function PersonalAgentAvatar({
  profile,
  size = "md",
}: {
  profile?: Profile;
  size?: "sm" | "md";
}) {
  return (
    <Avatar
      src={avatarURL(profile?.avatarIndex)}
      name={profile?.assistantName?.trim() || undefined}
      alt={`${personalAgentName(profile)} avatar`}
      size={size}
      tooltip={false}
      className="personal-agent-avatar"
    />
  );
}
