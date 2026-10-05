import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { ArrowUp, Mic, Plus, Square, X, FileText } from "lucide-react";
import {
  VStack,
  HStack,
  Button,
  ErrorNotice,
  Loading,
  Empty,
  Confirm,
} from "./ui";
import { useProfile, useSession } from "./session";
import {
  ConversationController,
  type ConversationState,
} from "./api/conversation";
import { Outbox, type PendingCommand } from "./api/outbox";
import { clientContext } from "./api/client";
import type { Receipt } from "./api/types";
import { Markdown, MessageParts, CopyText } from "./content";
import { uploadAttachment, type Attachment } from "./attachments";
import { personalAgentName } from "./personal-agent";
import { PersonalAgentAvatar } from "./PersonalAgentAvatar";

export default function Chat({ newTask = false }: { newTask?: boolean }) {
  const { taskId } = useParams();
  const { api, account } = useSession();
  const profile = useProfile();
  const location = useLocation();
  const navigate = useNavigate();
  const key = newTask ? "new-task" : taskId || "main";
  const draftKey = `impo:draft:${encodeURIComponent(account)}:${key}`;
  const [draft, setDraft] = useState(
    () => localStorage.getItem(draftKey) || "",
  );
  const [offeredDraft, setOfferedDraft] = useState<string>();
  const [state, setState] = useState<ConversationState>({
    messages: [],
    active: [],
    loading: !newTask,
  });
  const controller = useMemo(
    () =>
      new ConversationController(
        api,
        taskId ? `/tasks/${taskId}/conversation` : "/conversation",
        setState,
      ),
    [api, taskId],
  );
  const outbox = useMemo(
    () => new Outbox(account, key, localStorage),
    [account, key],
  );
  const [pending, setPending] = useState<PendingCommand | null>(() =>
    outbox.read(),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [files, setFiles] = useState<Attachment[]>([]);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const recorder = useRef<MediaRecorder | null>(null);
  const recorderTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [recording, setRecording] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  useEffect(() => {
    alive.current = true;
    if (!newTask) void controller.refresh();
    const refresh = () => {
      if (!document.hidden && !newTask) void controller.refresh();
    };
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      alive.current = false;
      controller.close();
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
      recorder.current?.stream.getTracks().forEach((t) => t.stop());
      if (recorder.current?.state === "recording") recorder.current.stop();
      clearTimeout(recorderTimer.current);
    };
  }, [controller, newTask]);
  useEffect(() => {
    try {
      draft
        ? localStorage.setItem(draftKey, draft)
        : localStorage.removeItem(draftKey);
    } catch {
      setError(
        new Error(
          "Your browser cannot save this draft. Keep this page open until it is sent.",
        ),
      );
    }
  }, [draft, draftKey]);
  useEffect(() => {
    const incoming = (location.state as { draft?: string } | null)?.draft;
    if (incoming) {
      if (draft && draft !== incoming) setOfferedDraft(incoming);
      else setDraft(incoming);
      navigate(location.pathname, { replace: true, state: null });
    }
  }, [location.key]);
  async function dispatch(command: PendingCommand) {
    setBusy(true);
    setError(undefined);
    try {
      const receipt = await api.mutate<Receipt>(command.path, command.body);
      if (!alive.current || api.controller.signal.aborted) return;
      outbox.clear();
      setPending(null);
      setDraft("");
      setFiles([]);
      if (newTask && receipt.taskId) navigate(`/tasks/${receipt.taskId}`);
      else
        controller.accepted(
          receipt,
          receipt.text || String(command.body.text || "Attached files"),
        );
    } catch (e) {
      if (alive.current) setError(e);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function send() {
    if (
      state.loading ||
      state.active.length > 0 ||
      busy ||
      pending ||
      recording ||
      voiceBusy ||
      files.some((f) => f.status !== "ready") ||
      (!draft.trim() && !files.length)
    )
      return;
    if (draft.length > (newTask ? 4000 : 32768)) {
      setError(
        new Error(
          `Keep this message under ${newTask ? "4,000" : "32,768"} characters.`,
        ),
      );
      return;
    }
    const command = {
      path: newTask
        ? "/tasks"
        : taskId
          ? `/tasks/${taskId}/messages`
          : "/conversation/messages",
      body: {
        clientMessageId: crypto.randomUUID(),
        text: draft,
        clientContext: clientContext(),
        ...(files.length ? { attachmentIds: files.map((f) => f.id) } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    try {
      outbox.save(command);
      setPending(command);
      void dispatch(command);
    } catch (e) {
      setError(e);
    }
  }
  async function upload(file: Attachment) {
    try {
      await uploadAttachment(api, file);
      if (alive.current)
        setFiles((v) =>
          v.map((f) => (f.id === file.id ? { ...f, status: "ready" } : f)),
        );
    } catch (e) {
      if (alive.current)
        setFiles((v) =>
          v.map((f) =>
            f.id === file.id
              ? { ...f, status: "failed", error: (e as Error).message }
              : f,
          ),
        );
    }
  }
  function addFiles(incoming: File[]) {
    if (pending || busy) return;
    if (files.length + incoming.length > 8) {
      setError(new Error("Attach up to 8 files per message."));
      return;
    }
    const additions: Attachment[] = incoming.map((file) => ({
      id: crypto.randomUUID(),
      file,
      status: "uploading",
    }));
    setFiles((v) => [...v, ...additions]);
    additions.forEach((f) => void upload(f));
  }
  async function recordVoice() {
    if (recording) {
      recorder.current?.stop();
      return;
    }
    setError(undefined);
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
        throw new Error(
          "Voice input is not supported in this browser. You can type your message instead.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const mime = ["audio/webm", "audio/mp4", "audio/ogg"].find((t) =>
        MediaRecorder.isTypeSupported(t),
      );
      if (!mime) {
        stream.getTracks().forEach((t) => t.stop());
        throw new Error("This browser cannot record a supported audio format.");
      }
      const rec = new MediaRecorder(stream, {
        mimeType: mime,
        audioBitsPerSecond: 64000,
      });
      recorder.current = rec;
      let parts: Blob[] = [];
      let size = 0;
      rec.ondataavailable = (e) => {
        parts.push(e.data);
        size += e.data.size;
        if (size > 1800000 && rec.state === "recording") rec.stop();
      };
      rec.onstop = async () => {
        clearTimeout(recorderTimer.current);
        stream.getTracks().forEach((t) => t.stop());
        if (!alive.current) return;
        setRecording(false);
        setVoiceBusy(true);
        try {
          const blob = new Blob(parts, { type: mime });
          if (!blob.size || blob.size > 2097152)
            throw new Error(
              "The voice clip is too large. Try a shorter message.",
            );
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (const b of bytes) binary += String.fromCharCode(b);
          const result = await api.mutate<{ text: string }>(
            "/voice/transcriptions",
            { audio: btoa(binary), mimeType: mime },
          );
          if (alive.current) setDraft((v) => v + (v ? "\n" : "") + result.text);
        } catch (e) {
          if (alive.current) setError(e);
        } finally {
          if (alive.current) setVoiceBusy(false);
        }
      };
      rec.onerror = () => {
        setError(new Error("Recording failed. Please try again."));
        if (rec.state === "recording") rec.stop();
      };
      rec.start(1000);
      setRecording(true);
      recorderTimer.current = setTimeout(() => {
        if (rec.state === "recording") rec.stop();
      }, 120000);
    } catch (e) {
      setError(e);
    }
  }
  const name = personalAgentName(profile.data);
  return (
    <VStack className="chat-page" gap={0}>
      <HStack
        className="chat-heading"
        padding={4}
        hAlign="between"
        vAlign="center"
        gap={3}
      >
        <HStack className="grow" gap={3} vAlign="center">
          <PersonalAgentAvatar profile={profile.data} />
          <VStack gap={1} className="grow">
            <h1>
              {newTask ? "A new task" : taskId ? state.title || "Task" : name}
            </h1>
            <small>
              {state.active.length
                ? "Working on it…"
                : newTask
                  ? "Give your personal agent something to take care of."
                  : "Your personal agent"}
            </small>
          </VStack>
        </HStack>
        {taskId && (
          <Button label="All tasks" href="/app/tasks" variant="ghost" />
        )}
      </HStack>
      <ChatLayout
        density="spacious"
        className="chat-layout"
        composer={
          <VStack gap={2}>
            {offeredDraft && (
              <HStack className="notice" gap={2} wrap="wrap">
                <p>
                  A Feed suggestion is ready. Keep your draft or use the
                  suggestion.
                </p>
                <Button
                  label="Keep draft"
                  onClick={() => setOfferedDraft(undefined)}
                />
                <Button
                  label="Use suggestion"
                  onClick={() => {
                    setDraft(offeredDraft);
                    setOfferedDraft(undefined);
                  }}
                />
              </HStack>
            )}
            {pending && (
              <HStack className="notice" gap={2} wrap="wrap">
                <p>
                  {busy
                    ? "Sending…"
                    : "Message delivery is unconfirmed. Retry safely with the same message."}
                </p>
                {!busy && (
                  <>
                    <Button
                      label="Retry message"
                      onClick={() => void dispatch(pending)}
                    />
                    <Confirm
                      label="Dismiss retry"
                      title="Dismiss this saved retry?"
                      description="The message may already have reached Impo. Check your conversation or task list before sending it again. Dismissing does not cancel any work on the server."
                      action={async () => {
                        outbox.clear();
                        setPending(null);
                        setError(undefined);
                        await controller.refresh();
                      }}
                    />
                  </>
                )}
              </HStack>
            )}
            {!!error && <ErrorNotice error={error} />}
            <ChatComposer
              value={draft}
              onChange={setDraft}
              onSubmit={send}
              isDisabled={busy || !!pending || recording || voiceBusy}
              elevation="none"
              placeholder={
                newTask
                  ? "What would you like me to take care of?"
                  : `Message ${profile.data?.assistantName?.trim() || "your personal agent"}…`
              }
              input={
                <ChatComposerInput
                  label="Message"
                  pasteAsToken={false}
                  hasHistory={false}
                  onFiles={addFiles}
                />
              }
              headerActions={
                files.length ? (
                  <HStack gap={2} wrap="wrap">
                    {files.map((f) => (
                      <HStack
                        key={f.id}
                        className="attachment"
                        gap={1}
                        vAlign="center"
                      >
                        <FileText />
                        <small>
                          {f.file.name} ·{" "}
                          {f.status === "uploading"
                            ? "Uploading…"
                            : f.status === "failed"
                              ? f.error
                              : "Ready"}
                        </small>
                        {f.status === "failed" && (
                          <Button
                            label="Retry upload"
                            size="sm"
                            onClick={() => {
                              setFiles((v) =>
                                v.map((x) =>
                                  x.id === f.id
                                    ? { ...x, status: "uploading" }
                                    : x,
                                ),
                              );
                              void upload(f);
                            }}
                          />
                        )}
                        <Button
                          label={`Remove ${f.file.name}`}
                          isIconOnly
                          icon={<X />}
                          variant="ghost"
                          size="sm"
                          isDisabled={!!pending}
                          onClick={() =>
                            setFiles((v) => v.filter((x) => x.id !== f.id))
                          }
                        />
                      </HStack>
                    ))}
                  </HStack>
                ) : undefined
              }
              footerActions={
                <HStack className="composer-tools" gap={1} vAlign="center">
                  <input
                    ref={input}
                    hidden
                    type="file"
                    multiple
                    accept=".pdf,.doc,.docx,.txt,.md,.csv,.json,.jpg,.jpeg,.png,.webp,.gif"
                    onChange={(e) => {
                      addFiles(Array.from(e.target.files || []));
                      e.target.value = "";
                    }}
                  />
                  <Button
                    label="Attach files"
                    tooltip="Attach files"
                    isIconOnly
                    icon={<Plus />}
                    variant="ghost"
                    isDisabled={busy || !!pending || recording}
                    onClick={() => input.current?.click()}
                  />
                  <Button
                    label={recording ? "Stop recording" : "Record voice"}
                    tooltip={recording ? "Stop recording" : "Record voice"}
                    isIconOnly
                    icon={recording ? <Square /> : <Mic />}
                    variant="ghost"
                    isDisabled={busy || !!pending || voiceBusy}
                    onClick={() => void recordVoice()}
                  />
                  <small>
                    {recording
                      ? "Recording · tap to finish"
                      : voiceBusy
                        ? "Transcribing…"
                        : profile.data?.mode || "Balanced"}
                  </small>
                </HStack>
              }
              sendButton={
                state.active.length ? (
                  <Button
                    label="Stop reply"
                    isIconOnly
                    icon={<Square />}
                    onClick={() => controller.cancel().catch(setError)}
                  />
                ) : (
                  <Button
                    label="Send message"
                    isIconOnly
                    icon={<ArrowUp />}
                    variant="primary"
                    isLoading={busy}
                    isDisabled={
                      state.loading ||
                      !!pending ||
                      recording ||
                      voiceBusy ||
                      files.some((f) => f.status !== "ready") ||
                      (!draft.trim() && !files.length)
                    }
                    onClick={send}
                  />
                )
              }
            />
            <p className="composer-note">
              {recording
                ? "Voice is recorded only while this page is open."
                : `${name} can make mistakes. Check important details.`}
            </p>
          </VStack>
        }
      >
        {state.loading ? (
          <Loading label="Picking up where you left off…" />
        ) : state.messages.length ? (
          <ChatMessageList>
            {state.messages.map((message) => (
              <VStack
                key={message.id}
                className={`message ${message.role === "user" ? "user" : "agent"}`}
                gap={3}
                as="article"
              >
                {message.role !== "user" && (
                  <HStack className="message-author" gap={2} vAlign="center">
                    <PersonalAgentAvatar profile={profile.data} size="sm" />
                    <p>{name}</p>
                  </HStack>
                )}
                <Markdown text={message.text} />
                <MessageParts message={message} />
                {message.role !== "user" && (
                  <HStack gap={2} vAlign="center">
                    <CopyText text={message.text} />
                    {["failed", "cancelled", "reconnecting"].includes(
                      message.status,
                    ) && <small>{message.status}</small>}
                  </HStack>
                )}
              </VStack>
            ))}
          </ChatMessageList>
        ) : (
          <Empty
            title={
              newTask ? "Leave it with me." : "A little more room for life."
            }
            body={
              newTask
                ? "Research a decision, work through a document, or plan what comes next."
                : "Make a plan, find something you love, or just start a conversation."
            }
          >
            <HStack className="suggestions" gap={2} wrap="wrap">
              {[
                "Help me plan my week",
                "Find a thoughtful gift",
                "What do you remember about me?",
              ].map((s) => (
                <Button
                  key={s}
                  label={s}
                  variant="secondary"
                  onClick={() => setDraft(s)}
                />
              ))}
            </HStack>
          </Empty>
        )}
        {state.error && (
          <ErrorNotice
            error={state.error}
            retry={() => void controller.reconnect()}
          />
        )}
      </ChatLayout>
    </VStack>
  );
}
