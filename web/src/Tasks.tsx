import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import { Plus, ArrowUpRight, Clock, CheckCircle2, Circle } from "lucide-react";
import {
  Page,
  VStack,
  HStack,
  Button,
  Empty,
  Loading,
  ErrorNotice,
  Dialog,
  DialogHeader,
  DialogBody,
  DialogFooter,
  TextInput,
  TextArea,
  Select,
  Confirm,
  dateTime,
  humanStatus,
} from "./ui";
import { useSession, useApiQuery } from "./session";
import type { Task, ScheduledTask, ScheduledRun, Schedule } from "./api/types";

export default function Tasks() {
  const tasks = useApiQuery<{ tasks: Task[] }>("/tasks");
  const schedules = useApiQuery<{ schedules: ScheduledTask[] }>(
    "/scheduled-tasks",
  );
  const [tab, setTab] = useState<"tasks" | "scheduled">("tasks");
  const [edit, setEdit] = useState<ScheduledTask | "new" | null>(null);
  const [runs, setRuns] = useState<ScheduledTask | null>(null);
  const { api } = useSession();
  const cache = useQueryClient();
  const [error, setError] = useState<unknown>();
  const [filter, setFilter] = useState("all");
  const refresh = () =>
    cache.invalidateQueries({ queryKey: ["/scheduled-tasks"] });
  return (
    <Page
      title="Leave it with Impo."
      eyebrow="Tasks"
      actions={
        <HStack gap={2} wrap="wrap">
          <Button
            label="Schedule a task"
            icon={<Clock />}
            onClick={() => setEdit("new")}
          />
          <Button
            label="New task"
            icon={<Plus />}
            variant="primary"
            href="/app/tasks/new"
          />
        </HStack>
      }
    >
      <HStack className="tabs" gap={2}>
        <Button
          label="Tasks"
          variant={tab === "tasks" ? "primary" : "ghost"}
          onClick={() => setTab("tasks")}
        />
        <Button
          label="Scheduled"
          variant={tab === "scheduled" ? "primary" : "ghost"}
          onClick={() => setTab("scheduled")}
        />
      </HStack>
      {!!error && <ErrorNotice error={error} />}
      {tab === "tasks" ? (
        <>
          {tasks.isPending ? (
            <Loading />
          ) : tasks.error ? (
            <ErrorNotice
              error={tasks.error}
              retry={() => void tasks.refetch()}
            />
          ) : !tasks.data.tasks.length ? (
            <Empty
              title="One less thing on your list."
              body="Give Impo a task and come back when it is ready."
            />
          ) : (
            <>
              <Select
                label="Show tasks"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "all", label: "All tasks" },
                  { value: "active", label: "In progress" },
                  { value: "completed", label: "Completed" },
                ]}
              />
              <VStack gap={0}>
                {tasks.data.tasks
                  .filter(
                    (t) =>
                      filter === "all" ||
                      (filter === "completed"
                        ? t.status === "completed"
                        : ["queued", "in_progress", "running"].includes(
                            t.status,
                          )),
                  )
                  .map((t) => (
                    <Link
                      className="list-row task-row"
                      to={`/tasks/${t.taskId}`}
                      key={t.taskId}
                    >
                      {t.status === "completed" ? <CheckCircle2 /> : <Circle />}
                      <VStack gap={2}>
                        <h3>{t.title}</h3>
                        <small>
                          {humanStatus(t.status)} ·{" "}
                          {dateTime(t.updatedAt || t.createdAt)}
                        </small>
                      </VStack>
                      <ArrowUpRight />
                    </Link>
                  ))}
              </VStack>
            </>
          )}
        </>
      ) : schedules.isPending ? (
        <Loading />
      ) : schedules.error ? (
        <ErrorNotice
          error={schedules.error}
          retry={() => void schedules.refetch()}
        />
      ) : !schedules.data.schedules.length ? (
        <Empty
          title="Make a little routine."
          body="Schedule a one-time, daily or weekly task in your time zone."
        >
          <Button label="Create a schedule" onClick={() => setEdit("new")} />
        </Empty>
      ) : (
        <VStack gap={0}>
          {schedules.data.schedules.map((t) => (
            <HStack key={t.id} className="list-row" gap={4} wrap="wrap">
              <VStack gap={2} className="grow">
                <h3>{t.title}</h3>
                <p>{t.goal}</p>
                <small>
                  {t.enabled
                    ? t.nextRunAt
                      ? `Next · ${dateTime(t.nextRunAt)}`
                      : "Enabled"
                    : "Paused"}{" "}
                  · {t.schedule.timeZone}
                </small>
              </VStack>
              <HStack gap={1} wrap="wrap">
                <Button
                  label="Runs"
                  variant="ghost"
                  onClick={() => setRuns(t)}
                />
                <Button
                  label="Edit"
                  variant="ghost"
                  onClick={() => setEdit(t)}
                />
                <Button
                  label={t.enabled ? "Pause" : "Resume"}
                  clickAction={async () => {
                    try {
                      await api.mutate(
                        `/scheduled-tasks/${t.id}`,
                        {
                          revision: t.revision,
                          title: t.title,
                          goal: t.goal,
                          schedule: t.schedule,
                          enabled: !t.enabled,
                        },
                        "PUT",
                      );
                      await refresh();
                    } catch (e) {
                      setError(e);
                      await refresh();
                    }
                  }}
                />
                <Confirm
                  title="Delete this schedule?"
                  description="Future runs will stop. Tasks already running will continue."
                  action={async () => {
                    await api.mutate(
                      `/scheduled-tasks/${t.id}`,
                      { revision: t.revision },
                      "DELETE",
                    );
                    await refresh();
                  }}
                />
              </HStack>
            </HStack>
          ))}
        </VStack>
      )}
      {edit && (
        <ScheduleEditor
          task={edit}
          close={() => setEdit(null)}
          saved={async () => {
            await refresh();
            setEdit(null);
            setTab("scheduled");
          }}
        />
      )}
      {runs && <RunHistory task={runs} close={() => setRuns(null)} />}
    </Page>
  );
}
function ScheduleEditor({
  task,
  close,
  saved,
}: {
  task: ScheduledTask | "new";
  close: () => void;
  saved: () => Promise<void>;
}) {
  const existing = task === "new" ? null : task;
  const { api } = useSession();
  const [title, setTitle] = useState(existing?.title || "");
  const [goal, setGoal] = useState(existing?.goal || "");
  const [frequency, setFrequency] = useState<Schedule["frequency"]>(
    existing?.schedule.frequency || "daily",
  );
  const [zone, setZone] = useState(
    existing?.schedule.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [time, setTime] = useState(existing?.schedule.time || "09:00");
  const [date, setDate] = useState(
    existing?.schedule.runAt
      ? new Date(
          new Date(existing.schedule.runAt).getTime() -
            new Date(existing.schedule.runAt).getTimezoneOffset() * 60000,
        )
          .toISOString()
          .slice(0, 16)
      : "",
  );
  const [days, setDays] = useState(
    existing?.schedule.weekdays || [1, 2, 3, 4, 5],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [requestId] = useState(() => crypto.randomUUID());
  const [frozen, setFrozen] = useState<unknown>();
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      if (
        !title.trim() ||
        title.length > 120 ||
        !goal.trim() ||
        goal.length > 4000
      )
        throw new Error(
          "Enter a title (up to 120 characters) and instructions (up to 4,000).",
        );
      new Intl.DateTimeFormat("en", { timeZone: zone });
      if (frequency === "once" && (!date || Date.parse(date) <= Date.now()))
        throw new Error("Choose a future date and time.");
      if (frequency === "weekly" && !days.length)
        throw new Error("Choose at least one day.");
      const body = frozen || {
        title: title.trim(),
        goal: goal.trim(),
        enabled: existing?.enabled ?? true,
        schedule: {
          frequency,
          timeZone: zone,
          runAt: frequency === "once" ? new Date(date).toISOString() : null,
          time: frequency === "once" ? null : time,
          weekdays: frequency === "weekly" ? days : [],
        },
        ...(existing
          ? { revision: existing.revision }
          : { clientRequestId: requestId }),
      };
      if (!existing) setFrozen(body);
      await api.mutate(
        existing ? `/scheduled-tasks/${existing.id}` : "/scheduled-tasks",
        body,
        existing ? "PUT" : "POST",
      );
      await saved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      isOpen
      onOpenChange={(v) => !v && !busy && close()}
      purpose="form"
      width={620}
    >
      <DialogHeader
        title={existing ? "Edit schedule" : "A task, right on time"}
        onOpenChange={(v) => !v && !busy && close()}
      />
      <DialogBody>
        <TextInput
          label="Title"
          value={title}
          onChange={setTitle}
          isDisabled={!!frozen}
        />
        <TextArea
          label="What should Impo do?"
          rows={4}
          value={goal}
          onChange={setGoal}
          isDisabled={!!frozen}
        />
        <Select
          label="Repeat"
          value={frequency}
          onChange={(v) => setFrequency(v as Schedule["frequency"])}
          options={["once", "daily", "weekly"].map((v) => ({
            value: v,
            label: v[0].toUpperCase() + v.slice(1),
          }))}
        />
        <TextInput
          label="Time zone"
          value={zone}
          onChange={setZone}
          description="An IANA time zone, for example America/Los_Angeles."
        />
        {frequency === "once" ? (
          <label className="field">
            Date and time ({Intl.DateTimeFormat().resolvedOptions().timeZone})
            <input
              type="datetime-local"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </label>
        ) : (
          <label className="field">
            Time
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </label>
        )}
        {frequency === "weekly" && (
          <HStack gap={2} wrap="wrap">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
              (name, i) => (
                <label key={name}>
                  <input
                    type="checkbox"
                    checked={days.includes(i + 1)}
                    onChange={(e) =>
                      setDays((v) =>
                        e.target.checked
                          ? [...v, i + 1]
                          : v.filter((x) => x !== i + 1),
                      )
                    }
                  />
                  {name}
                </label>
              ),
            )}
          </HStack>
        )}
        {!!error && <ErrorNotice error={error} />}
      </DialogBody>
      <DialogFooter>
        <Button label="Cancel" onClick={close} isDisabled={busy} />
        <Button
          label={frozen ? "Retry creation" : "Save schedule"}
          variant="primary"
          isLoading={busy}
          onClick={() => void save()}
        />
      </DialogFooter>
    </Dialog>
  );
}
function RunHistory({
  task,
  close,
}: {
  task: ScheduledTask;
  close: () => void;
}) {
  const { api } = useSession();
  const navigate = useNavigate();
  const q = useInfiniteQuery({
    queryKey: ["runs", task.id],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.get<{ runs: ScheduledRun[]; nextCursor: string | null }>(
        `/scheduled-tasks/${task.id}/runs${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (p) => p.nextCursor || undefined,
  });
  return (
    <Dialog isOpen onOpenChange={(v) => !v && close()} width={600}>
      <DialogHeader
        title={`Runs · ${task.title}`}
        onOpenChange={(v) => !v && close()}
      />
      <DialogBody gap={3}>
        {q.isPending ? (
          <Loading />
        ) : q.error ? (
          <ErrorNotice error={q.error} retry={() => void q.refetch()} />
        ) : q.data.pages.flatMap((p) => p.runs).length ? (
          q.data.pages
            .flatMap((p) => p.runs)
            .map((r) => (
              <HStack className="list-row" key={r.id} hAlign="between">
                <VStack>
                  <p>{dateTime(r.scheduledAt)}</p>
                  <small>{humanStatus(r.status)}</small>
                </VStack>
                {r.taskId && (
                  <Button
                    label="Open task"
                    onClick={() => navigate(`/tasks/${r.taskId}`)}
                  />
                )}
              </HStack>
            ))
        ) : (
          <p>No runs yet. Your first run will appear here.</p>
        )}
        {q.hasNextPage && (
          <Button
            label="Load earlier runs"
            isLoading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}
