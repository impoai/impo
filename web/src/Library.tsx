import { useState } from "react";
import { useNavigate } from "react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Headphones, MapPin } from "lucide-react";
import {
  Page,
  VStack,
  HStack,
  DateInput,
  type DateInputProps,
  Button,
  Empty,
  Loading,
  ErrorNotice,
  TextInput,
  Dialog,
  DialogHeader,
  DialogBody,
  Confirm,
  Select,
  dateTime,
  humanStatus,
} from "./ui";
import { useSession, useApiQuery } from "./session";
import type { Memory, Recording, SpeakerReview } from "./api/types";
import { Markdown, CopyText } from "./content";

export function Memories() {
  const { api } = useSession();
  const navigate = useNavigate();
  const [category, setCategory] = useState("");
  const [search, setSearch] = useState("");
  const cache = useQueryClient();
  const summary = useApiQuery<{
    total: number;
    categories: Record<string, number>;
  }>("/memories/summary");
  const query = useInfiniteQuery({
    queryKey: ["memories", category],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.get<{ memories: Memory[]; nextCursor: string | null }>(
        `/memories?limit=30${category ? `&category=${encodeURIComponent(category)}` : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (p) => p.nextCursor || undefined,
  });
  const rows = query.data?.pages.flatMap((p) => p.memories) || [];
  return (
    <Page
      title="The little things that matter."
      eyebrow="Memories"
      actions={
        <Button
          label="Remember something"
          icon={<Brain />}
          onClick={() =>
            navigate("/", { state: { draft: "Please remember: " } })
          }
        />
      }
    >
      <p className="lede">
        The context that helps Impo feel a little more like yours. You are
        always in control of what stays.
      </p>
      <HStack className="filter-row" gap={3} wrap="wrap" vAlign="end">
        <TextInput
          label="Search loaded memories"
          value={search}
          onChange={setSearch}
          hasClear
        />
        <Select
          label="Category"
          value={category}
          onChange={setCategory}
          options={[
            {
              value: "",
              label: `All memories${summary.data ? ` · ${summary.data.total}` : ""}`,
            },
            ...Object.keys(summary.data?.categories || {}).map((value) => ({
              value,
              label: humanStatus(value),
            })),
          ]}
        />
      </HStack>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : !rows.length ? (
        <Empty
          title="Getting to know you."
          body="Share what matters in Chat. Useful context will appear here as memories."
        />
      ) : (
        <VStack gap={0}>
          {rows
            .filter((m) =>
              m.content.toLowerCase().includes(search.toLowerCase()),
            )
            .map((m) => (
              <HStack key={m.id} className="list-row" gap={4} vAlign="start">
                <VStack gap={3} className="grow">
                  <p className="eyebrow">
                    {m.categories.map(humanStatus).join(" · ")}
                  </p>
                  <Markdown text={m.content} />
                  <small>Updated {dateTime(m.updatedAt)}</small>
                </VStack>
                <Confirm
                  title="Forget this memory?"
                  description="Impo will no longer use this memory as personal context."
                  action={async () => {
                    await api.mutate(`/memories/${m.id}`, {}, "DELETE");
                    await cache.invalidateQueries({ queryKey: ["memories"] });
                    await cache.invalidateQueries({
                      queryKey: ["/memories/summary"],
                    });
                  }}
                />
              </HStack>
            ))}
          {search &&
            !rows.some((m) =>
              m.content.toLowerCase().includes(search.toLowerCase()),
            ) && (
              <p>
                No matches in the loaded memories. Load more to keep searching.
              </p>
            )}
        </VStack>
      )}
      {query.hasNextPage && (
        <Button
          label="Load more memories"
          isLoading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      )}
    </Page>
  );
}
export function Echo() {
  const { api } = useSession();
  const [search, setSearch] = useState("");
  const [date, setDate] = useState<DateInputProps["value"]>();
  const [selected, setSelected] = useState<Recording | null>(null);
  const query = useInfiniteQuery({
    queryKey: ["echo", date],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) => {
      let range = "";
      if (date) {
        const from = new Date(`${date}T00:00:00`);
        const to = new Date(from);
        to.setDate(to.getDate() + 1);
        range = `from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`;
      } else
        range = `limit=30${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`;
      return api.get<{ segments: Recording[]; nextCursor?: string | null }>(
        `/listening/segments?${range}`,
        signal,
      );
    },
    getNextPageParam: (p) => p.nextCursor || undefined,
    refetchInterval: 30000,
  });
  const rows = query.data?.pages.flatMap((p) => p.segments) || [];
  return (
    <Page
      title="Keep a little of your day."
      eyebrow="Echo"
      actions={
        <Button
          label="Recording schedule"
          href="/app/settings#echo"
          icon={<Headphones />}
        />
      }
    >
      <p className="lede">
        Review recordings from your phone. Confirm your words so Impo can use
        them in your memories and Feed.
      </p>
      <HStack className="filter-row" gap={4} wrap="wrap" vAlign="end">
        <TextInput
          label="Search loaded transcripts"
          value={search}
          onChange={setSearch}
          hasClear
        />
        <DateInput
          label="Recorded on"
          placeholder="All dates"
          presentation="native"
          format="date"
          value={date}
          onChange={setDate}
          hasClear
          width="var(--impo-field-min-width)"
        />
      </HStack>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : !rows.length ? (
        <Empty
          title="Some days are worth keeping."
          body="Record with Echo on your phone. Your transcripts will be ready to review here."
        />
      ) : (
        <VStack gap={0}>
          {rows
            .filter((r) =>
              (r.transcript || "").toLowerCase().includes(search.toLowerCase()),
            )
            .map((r) => (
              <button
                className="list-row recording-row"
                key={r.id}
                onClick={() => setSelected(r)}
              >
                <VStack gap={2}>
                  <HStack gap={3} wrap="wrap">
                    <b>{dateTime(r.startedAt)}</b>
                    <small>
                      {humanStatus(r.status)} ·{" "}
                      {r.speakerReview?.status === "confirmed"
                        ? "Your words confirmed"
                        : "Review speakers"}
                    </small>
                  </HStack>
                  <p className="excerpt">
                    {r.transcript || r.error || "Transcription in progress…"}
                  </p>
                  {r.location?.label && <small>{r.location.label}</small>}
                </VStack>
              </button>
            ))}
        </VStack>
      )}
      {query.hasNextPage && (
        <Button
          label="Load earlier recordings"
          isLoading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      )}
      {selected && (
        <RecordingDetail
          record={selected}
          close={() => setSelected(null)}
          saved={async () => {
            await query.refetch();
            setSelected(null);
          }}
        />
      )}
    </Page>
  );
}
function RecordingDetail({
  record: r,
  close,
  saved,
}: {
  record: Recording;
  close: () => void;
  saved: () => Promise<void>;
}) {
  const { api } = useSession();
  const [label, setLabel] = useState(r.location?.label || "");
  const [review, setReview] = useState<SpeakerReview>(
    r.speakerReview || {
      revision: 0,
      status: "unconfirmed",
      selfSpeakerIds: [],
      excludedUtteranceIds: [],
    },
  );
  const [error, setError] = useState<unknown>();
  const speakers = [
    ...new Set(
      r.utterances?.flatMap((u) => (u.speaker ? [u.speaker] : [])) || [],
    ),
  ];
  const [deleting, setDeleting] = useState(false);
  return (
    <Dialog
      isOpen
      onOpenChange={(v) => !v && close()}
      width={760}
      maxHeight="90dvh"
      purpose="form"
    >
      <DialogHeader
        title={dateTime(r.startedAt)}
        subtitle="Echo transcript"
        onOpenChange={(v) => !v && close()}
      />
      <DialogBody gap={5}>
        {!!error && <ErrorNotice error={error} />}
        <HStack gap={2}>
          <CopyText text={r.transcript || ""} />
          <Button
            label="Delete recording"
            variant="ghost"
            onClick={() => setDeleting(!deleting)}
          />
        </HStack>
        {deleting && (
          <VStack className="notice" gap={3}>
            <p>
              Delete this recording, transcript and its personal context? This
              cannot be undone.
            </p>
            <Button
              label="Delete permanently"
              variant="destructive"
              clickAction={async () => {
                try {
                  await api.mutate(`/listening/segments/${r.id}`, {}, "DELETE");
                  await saved();
                } catch (e) {
                  setError(e);
                }
              }}
            />
          </VStack>
        )}
        <TextInput
          label="Place label"
          value={label}
          onChange={setLabel}
          description="Add a name such as Home or Office."
        />
        <Button
          label="Save place"
          icon={<MapPin />}
          clickAction={async () => {
            try {
              await api.mutate(
                `/listening/segments/${r.id}/location`,
                { label },
                "PATCH",
              );
              await saved();
            } catch (e) {
              setError(e);
            }
          }}
        />
        {speakers.length > 0 && (
          <VStack gap={3}>
            <h3>Which voice is yours?</h3>
            <p>Only your confirmed, included words become personal context.</p>
            <HStack gap={3} wrap="wrap">
              {speakers.map((s) => (
                <label key={s}>
                  <input
                    type="checkbox"
                    checked={review.selfSpeakerIds.includes(s)}
                    onChange={(e) =>
                      setReview((v) => {
                        const ids = e.target.checked
                          ? [...v.selfSpeakerIds, s]
                          : v.selfSpeakerIds.filter((x) => x !== s);
                        return {
                          ...v,
                          selfSpeakerIds: ids,
                          status: ids.length ? "confirmed" : "unconfirmed",
                          excludedUtteranceIds: ids.length
                            ? v.excludedUtteranceIds
                            : [],
                        };
                      })
                    }
                  />
                  Speaker {speakers.indexOf(s) + 1}
                </label>
              ))}
            </HStack>
            <Select
              label="Review status"
              value={review.status}
              onChange={(v) =>
                setReview((x) => ({
                  ...x,
                  status: v as SpeakerReview["status"],
                  ...(v !== "confirmed"
                    ? { selfSpeakerIds: [], excludedUtteranceIds: [] }
                    : {}),
                }))
              }
              options={[
                { value: "unconfirmed", label: "Not reviewed" },
                { value: "confirmed", label: "My voice is selected" },
                { value: "not_present", label: "I am not in this recording" },
              ]}
            />
          </VStack>
        )}
        {r.utterances?.length ? (
          <VStack gap={3}>
            {r.utterances.map((u) => (
              <VStack className="utterance" gap={2} key={u.id}>
                <p className="eyebrow">
                  {u.speaker
                    ? `Speaker ${speakers.indexOf(u.speaker) + 1}`
                    : "Unknown speaker"}{" "}
                  · {Math.floor(u.startMs / 60000)}:
                  {String(Math.floor(u.startMs / 1000) % 60).padStart(2, "0")}
                </p>
                <p>{u.text}</p>
                {u.speaker && review.selfSpeakerIds.includes(u.speaker) && (
                  <label>
                    <input
                      type="checkbox"
                      checked={!review.excludedUtteranceIds.includes(u.id)}
                      onChange={(e) =>
                        setReview((v) => ({
                          ...v,
                          excludedUtteranceIds: e.target.checked
                            ? v.excludedUtteranceIds.filter((x) => x !== u.id)
                            : [...v.excludedUtteranceIds, u.id],
                        }))
                      }
                    />{" "}
                    Include in personal context
                  </label>
                )}
              </VStack>
            ))}
          </VStack>
        ) : (
          <Markdown text={r.transcript || "Transcript is not available yet."} />
        )}
        {speakers.length > 0 && (
          <Button
            label="Save speaker review"
            variant="primary"
            clickAction={async () => {
              try {
                await api.mutate(
                  `/listening/segments/${r.id}/speakers`,
                  review,
                  "PATCH",
                );
                await saved();
              } catch (e) {
                setError(e);
              }
            }}
          />
        )}
      </DialogBody>
    </Dialog>
  );
}
