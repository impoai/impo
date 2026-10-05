import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Page,
  VStack,
  HStack,
  Button,
  Loading,
  ErrorNotice,
  TextInput,
  Switch,
  Select,
  Confirm,
  Dialog,
  DialogHeader,
  DialogBody,
} from "./ui";
import { useSession, useProfile, useApiQuery } from "./session";
import type { Profile, TodaySettings, EchoSchedule } from "./api/types";
import { clearAccountStorage } from "./api/outbox";

import { AvatarChoice } from "./AvatarChoice";
export default function Settings() {
  const profile = useProfile();
  const { email, signOut, manageAccount } = useSession();
  const [deletion, setDeletion] = useState(false);
  return (
    <Page title="Make yourself at home." eyebrow="Settings">
      <VStack className="settings-sections" gap={8}>
        <section>
          <h2>Your personal agent</h2>
          {profile.isPending ? (
            <Loading />
          ) : profile.error ? (
            <ErrorNotice
              error={profile.error}
              retry={() => void profile.refetch()}
            />
          ) : (
            <ProfileForm profile={profile.data} />
          )}
        </section>
        <section id="feed">
          <h2>Your Feed</h2>
          <FeedSettings />
        </section>
        <section id="echo">
          <h2>Echo on your phone</h2>
          <EchoSettings />
        </section>
        <section>
          <h2>Notifications</h2>
          <NotificationSettings />
        </section>
        <VStack as="section" gap={4}>
          <h2>Your account</h2>
          <p>{email}</p>
          <HStack gap={2} wrap="wrap">
            <Button
              label="Manage sign-in and security"
              onClick={manageAccount}
            />
            <Confirm
              label="Sign out"
              title="Sign out of Impo?"
              description="Saved account data and running tasks will remain available when you sign in again. Drafts on this browser will be cleared."
              action={signOut}
            />
            <Button
              label="Delete account"
              variant="ghost"
              onClick={() => setDeletion(true)}
            />
          </HStack>
          <HStack className="support-links" gap={4} wrap="wrap">
            <a href="/privacy/" target="_blank" rel="noreferrer">
              Privacy
            </a>
            <a href="/terms/" target="_blank" rel="noreferrer">
              Terms
            </a>
            <a href="mailto:cj@impo.ai">Contact support</a>
          </HStack>
        </VStack>
      </VStack>
      {deletion && <DeleteAccount close={() => setDeletion(false)} />}
    </Page>
  );
}
function ProfileForm({ profile }: { profile: Profile }) {
  const { api } = useSession();
  const cache = useQueryClient();
  const [name, setName] = useState(profile.assistantName || "");
  const [avatar, setAvatar] = useState(profile.avatarIndex);
  const [mode, setMode] = useState(profile.mode || "Balanced");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  return (
    <VStack gap={4}>
      <AvatarChoice value={avatar} onChange={setAvatar} />
      {avatar === 6 && (
        <p className="muted">
          Your custom photo is stored on your phone. Choose a shared avatar
          above to show the same image on the web.
        </p>
      )}
      <TextInput
        label="Personal agent name"
        placeholder="e.g. Momo"
        value={name}
        onChange={setName}
      />
      <Select
        label="Mode"
        value={mode}
        onChange={(v) => setMode(v as Profile["mode"])}
        options={[
          { value: "Balanced", label: "Balanced · thoughtful everyday help" },
          { value: "Power", label: "Power · more depth for demanding tasks" },
        ]}
      />
      {!!error && <ErrorNotice error={error} />}
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label="Save personal agent"
          variant="primary"
          isDisabled={!name.trim() || avatar === undefined}
          clickAction={async () => {
            setError(undefined);
            setSaved(false);
            try {
              const savedProfile = await api.mutate<Profile>(
                "/profile",
                { assistantName: name, avatarIndex: avatar, mode },
                "PATCH",
              );
              cache.setQueryData(["/profile"], savedProfile);
              setName(savedProfile.assistantName || "");
              setAvatar(savedProfile.avatarIndex);
              setSaved(true);
            } catch (e) {
              setError(e);
            }
          }}
        />
        {saved && <p role="status">Saved</p>}
      </HStack>
    </VStack>
  );
}
function FeedSettings() {
  const q = useApiQuery<{ settings: TodaySettings | null }>("/today/settings");
  return q.isPending ? (
    <Loading />
  ) : q.error ? (
    <ErrorNotice error={q.error} retry={() => void q.refetch()} />
  ) : (
    <FeedForm
      key={q.data.settings ? "configured" : "new"}
      initial={q.data.settings}
    />
  );
}
function FeedForm({ initial }: { initial: TodaySettings | null }) {
  const { api } = useSession();
  const cache = useQueryClient();
  const [v, setV] = useState<TodaySettings>(
    initial
      ? {
          timeZone: initial.timeZone,
          locale: initial.locale,
          displayName: initial.displayName || "",
          slots: initial.slots,
          location: initial.location,
          contentPreferences: initial.contentPreferences,
        }
      : {
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.language,
          displayName: "",
          slots: [
            { id: "morning", label: "Morning", hour: 8, enabled: true },
            { id: "evening", label: "Evening", hour: 18, enabled: true },
          ],
        },
  );
  const [city, setCity] = useState(initial?.location?.city || "");
  const [country, setCountry] = useState(initial?.location?.country || "");
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  return (
    <VStack gap={4}>
      <TextInput
        label="Your name"
        value={v.displayName}
        onChange={(displayName) => setV({ ...v, displayName })}
      />
      <HStack className="form-row" gap={3} wrap="wrap">
        <TextInput
          label="Time zone"
          value={v.timeZone}
          onChange={(timeZone) => setV({ ...v, timeZone })}
        />
        <TextInput
          label="Language / locale"
          value={v.locale}
          onChange={(locale) => setV({ ...v, locale })}
        />
      </HStack>
      <HStack className="form-row" gap={3} wrap="wrap">
        <TextInput label="City (optional)" value={city} onChange={setCity} />
        <TextInput
          label="Country (optional)"
          value={country}
          onChange={setCountry}
        />
      </HStack>
      <h3>When your Feed arrives</h3>
      {v.slots.map((s, index) => (
        <HStack
          className="schedule-slot"
          gap={3}
          wrap="wrap"
          vAlign="end"
          key={s.id}
        >
          <label>
            <input
              type="checkbox"
              checked={s.enabled}
              onChange={(e) =>
                setV({
                  ...v,
                  slots: v.slots.map((x, i) =>
                    i === index ? { ...x, enabled: e.target.checked } : x,
                  ),
                })
              }
            />
            {s.label}
          </label>
          <label className="field">
            Hour
            <select
              value={s.hour}
              onChange={(e) =>
                setV({
                  ...v,
                  slots: v.slots.map((x, i) =>
                    i === index ? { ...x, hour: Number(e.target.value) } : x,
                  ),
                })
              }
            >
              {Array.from({ length: 24 }, (_, i) => (
                <option value={i} key={i}>
                  {String(i).padStart(2, "0")}:00
                </option>
              ))}
            </select>
          </label>
        </HStack>
      ))}
      <h3>What is in your Feed</h3>
      {["suggestion", "recap", "connect", "feature", "occasion"].map((key) => (
        <label key={key}>
          <input
            type="checkbox"
            checked={v.contentPreferences?.categories[key] ?? true}
            onChange={(e) =>
              setV({
                ...v,
                contentPreferences: {
                  occasionCalendar:
                    v.contentPreferences?.occasionCalendar || "none",
                  categories: {
                    suggestion: true,
                    recap: true,
                    connect: true,
                    feature: true,
                    occasion: true,
                    ...v.contentPreferences?.categories,
                    [key]: e.target.checked,
                  },
                },
              })
            }
          />
          {
            (
              {
                suggestion: "Suggestions",
                recap: "Recaps",
                connect: "Connections",
                feature: "Ways to use Impo",
                occasion: "Occasions",
              } as Record<string, string>
            )[key]
          }
        </label>
      ))}
      {!!error && <ErrorNotice error={error} />}
      <HStack gap={3} wrap="wrap">
        <Button
          label="Save Feed preferences"
          variant="primary"
          clickAction={async () => {
            setError(undefined);
            setSaved(false);
            try {
              await api.mutate(
                "/today/settings",
                {
                  ...v,
                  briefClientVersion: 2,
                  location: city.trim()
                    ? {
                        city: city.trim(),
                        country,
                        capturedAt: new Date().toISOString(),
                        source: "manual",
                      }
                    : null,
                },
                "PUT",
              );
              await cache.invalidateQueries({ queryKey: ["/today/settings"] });
              await cache.invalidateQueries({ queryKey: ["/profile"] });
              setSaved(true);
            } catch (e) {
              setError(e);
            }
          }}
        />
        <Confirm
          label="Reset suggestions"
          title="Reset your suggestion history?"
          description="Dismissed and snoozed topics may appear in future Feed editions again."
          action={() => api.mutate("/today/topics/reset")}
        />
        {saved && <p role="status">Saved</p>}
      </HStack>
    </VStack>
  );
}
function EchoSettings() {
  const q = useApiQuery<EchoSchedule>("/echo/schedule");
  return q.isPending ? (
    <Loading />
  ) : q.error ? (
    <ErrorNotice error={q.error} retry={() => void q.refetch()} />
  ) : (
    <EchoForm initial={q.data} saved={() => q.refetch()} />
  );
}
function EchoForm({
  initial,
  saved,
}: {
  initial: EchoSchedule;
  saved: () => Promise<unknown>;
}) {
  const { api } = useSession();
  const [v, setV] = useState(initial);
  const [error, setError] = useState<unknown>();
  const [ok, setOk] = useState(false);
  return (
    <VStack gap={4}>
      <p>
        Reminders help you start Echo on your phone. Recording still requires
        your phone and its microphone permission.
      </p>
      <label>
        <input
          type="checkbox"
          checked={v.enabled}
          onChange={(e) => setV({ ...v, enabled: e.target.checked })}
        />{" "}
        Enable reminders
      </label>
      <HStack gap={3} wrap="wrap">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((s, i) => (
          <label key={s}>
            <input
              type="checkbox"
              checked={v.weekdays.includes(i + 1)}
              onChange={(e) =>
                setV({
                  ...v,
                  weekdays: e.target.checked
                    ? [...v.weekdays, i + 1]
                    : v.weekdays.filter((x) => x !== i + 1),
                })
              }
            />
            {s}
          </label>
        ))}
      </HStack>
      <HStack className="form-row" gap={3} wrap="wrap">
        <label className="field">
          Reminder
          <input
            type="time"
            value={v.reminderTime}
            onChange={(e) => setV({ ...v, reminderTime: e.target.value })}
          />
        </label>
        <label className="field">
          Stop time
          <input
            type="time"
            value={v.stopTime}
            onChange={(e) => setV({ ...v, stopTime: e.target.value })}
          />
        </label>
      </HStack>
      <label>
        <input
          type="checkbox"
          checked={v.autoStop}
          onChange={(e) => setV({ ...v, autoStop: e.target.checked })}
        />{" "}
        Stop automatically on your phone
      </label>
      <TextInput
        label="Echo time zone"
        value={v.timeZone}
        onChange={(timeZone) => setV({ ...v, timeZone })}
      />
      {!!error && <ErrorNotice error={error} />}
      <HStack gap={3} vAlign="center" wrap="wrap">
        <Button
          label="Save Echo schedule"
          variant="primary"
          clickAction={async () => {
            setError(undefined);
            setOk(false);
            try {
              const result = await api.mutate<EchoSchedule>(
                "/echo/schedule",
                v,
                "PUT",
              );
              setV(result);
              await saved();
              setOk(true);
            } catch (e) {
              setError(e);
            }
          }}
        />
        {ok && <p role="status">Saved</p>}
      </HStack>
    </VStack>
  );
}
function NotificationSettings() {
  const { api } = useSession();
  const q = useApiQuery<Record<string, boolean>>("/notifications/settings");
  const [error, setError] = useState<unknown>();
  return (
    <VStack gap={4}>
      <p>
        Choose the updates sent to your registered phones. Web push
        notifications are not enabled.
      </p>
      {q.isPending ? (
        <Loading />
      ) : q.error ? (
        <ErrorNotice error={q.error} retry={() => void q.refetch()} />
      ) : (
        Object.entries({
          chat: "Chat replies",
          tasks: "Task updates",
          brief: "Feed editions",
          scheduledTasks: "Scheduled tasks",
          echo: "Echo reminders",
        }).map(([key, label]) => (
          <Switch
            key={key}
            label={label}
            labelPosition="start"
            labelSpacing="spread"
            width="100%"
            value={q.data[key]}
            changeAction={async (checked) => {
              try {
                await api.mutate(
                  "/notifications/settings",
                  { [key]: checked },
                  "PATCH",
                );
                await q.refetch();
              } catch (e) {
                setError(e);
              }
            }}
          />
        ))
      )}
      {!!error && <ErrorNotice error={error} />}
    </VStack>
  );
}
interface Challenge {
  challengeId: string;
  token: string;
  expiresAt: string;
}
interface DeletionReceipt {
  requestId: string;
  receiptToken?: string;
  status: string;
  appleManualRevocationRequired: boolean;
}
function DeleteAccount({ close }: { close: () => void }) {
  const { api, account, signOut } = useSession();
  const [challenge, setChallenge] = useState<Challenge>();
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<DeletionReceipt>();
  async function remove() {
    if (text !== "DELETE" || !challenge) return;
    setBusy(true);
    setError(undefined);
    const body = {
      challengeId: challenge.challengeId,
      token: challenge.token,
      confirmation: "DELETE",
    };
    const key = `impo:deletion:${encodeURIComponent(account)}`;
    try {
      localStorage.setItem(key, JSON.stringify({ ...body, confirmed: true }));
      let result: DeletionReceipt;
      try {
        result = await api.mutate("/account", body, "DELETE");
      } catch (e) {
        const response = await fetch(
          `/api/v1/account/deletions/${challenge.challengeId}`,
          {
            headers: { Authorization: `Bearer ${challenge.token}` },
            credentials: "omit",
            cache: "no-store",
          },
        );
        if (!response.ok) throw e;
        result = await response.json();
      }
      localStorage.setItem(
        "impo:deletion-receipt",
        JSON.stringify({
          ...result,
          receiptToken: result.receiptToken || challenge.token,
        }),
      );
      localStorage.removeItem(key);
      clearAccountStorage(account, localStorage);
      setReceipt(result);
      api.close();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      isOpen
      onOpenChange={(v) => !v && !busy && !receipt && close()}
      purpose={receipt ? "required" : "form"}
      width={560}
    >
      <DialogHeader
        title={
          receipt ? "Account deletion requested" : "Delete your Impo account"
        }
        onOpenChange={receipt ? undefined : (v) => !v && !busy && close()}
      />
      <DialogBody>
        {receipt ? (
          <>
            <p>
              Your account data is no longer available. Provider cleanup usually
              finishes within 24 hours.
            </p>
            {receipt.appleManualRevocationRequired && (
              <p>
                If you used Sign in with Apple, remove Impo from your Apple
                Account’s Sign in with Apple settings.
              </p>
            )}
            <Button
              label="Sign out"
              variant="primary"
              onClick={() => void signOut()}
            />
          </>
        ) : (
          <>
            <p>
              This permanently removes your conversations, tasks, memories,
              recordings and connected app access. It cannot be undone.
            </p>
            {!challenge ? (
              <Button
                label="Continue to confirmation"
                variant="destructive"
                clickAction={async () => {
                  try {
                    setChallenge(
                      await api.mutate("/account/deletion-challenge"),
                    );
                  } catch (e) {
                    setError(e);
                  }
                }}
              />
            ) : (
              <>
                <TextInput
                  label="Type DELETE to confirm"
                  value={text}
                  onChange={setText}
                />
                <Button
                  label="Permanently delete account"
                  variant="destructive"
                  isLoading={busy}
                  isDisabled={text !== "DELETE"}
                  onClick={() => void remove()}
                />
              </>
            )}
            <Button label="Keep my account" isDisabled={busy} onClick={close} />
          </>
        )}
        {!!error && <ErrorNotice error={error} />}
      </DialogBody>
    </Dialog>
  );
}
