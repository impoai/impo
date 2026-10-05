import { HStack } from "./ui";
import { avatars, avatarURL } from "./personal-agent";
export function AvatarChoice({
  value,
  onChange,
}: {
  value?: number;
  onChange: (value: number) => void;
}) {
  return (
    <HStack
      className="avatar-options"
      gap={2}
      wrap="wrap"
      role="group"
      aria-label="Choose your personal agent avatar"
    >
      {avatars.map((a, i) => (
        <button
          className={`avatar-choice ${i === value ? "selected" : ""}`}
          key={a}
          aria-label={a}
          aria-pressed={i === value}
          onClick={() => onChange(i)}
        >
          <img src={avatarURL(i)} alt="" />
        </button>
      ))}
    </HStack>
  );
}
