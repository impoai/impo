import { useState } from "react";
import { useNavigate } from "react-router";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, SlidersHorizontal, Printer, Trash2 } from "lucide-react";
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
  Confirm,
  DateInput,
  type DateInputProps,
} from "./ui";
import { useSession } from "./session";
import type { Brief, FeedCard, FeedAction } from "./api/types";
import { safeHTTPS } from "./api/client";
import { Markdown } from "./content";

export default function Feed() {
  const { api } = useSession();
  const navigate = useNavigate();
  const cache = useQueryClient();
  const [date, setDate] = useState<DateInputProps["value"]>();
  const [source, setSource] = useState<{ title: string; text?: string } | null>(
    null,
  );
  const [error, setError] = useState<unknown>();
  const query = useInfiniteQuery({
    queryKey: ["feed", date],
    initialPageParam: "",
    queryFn: ({ pageParam, signal }) =>
      api.get<{ briefs: Brief[]; nextCursor: string | null }>(
        `/today/briefs?limit=10${date ? `&date=${date}` : ""}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`,
        signal,
      ),
    getNextPageParam: (p) => p.nextCursor || undefined,
    refetchInterval: 60000,
  });
  async function action(brief: Brief, card: FeedCard) {
    try {
      const { action: a } = await api.mutate<{ action: FeedAction }>(
        `/today/briefs/${brief.id}/cards/${card.id}/action`,
      );
      if (a.kind === "chat_draft" && a.prompt)
        navigate("/", { state: { draft: a.prompt } });
      else if (a.kind === "connect") navigate("/connections");
      else if (a.kind === "open_resource" && /^[0-9a-f-]{36}$/i.test(a.target))
        navigate(`/tasks/${a.target}`);
      else if (a.kind === "open_feature")
        navigate(
          a.target === "scheduled-tasks"
            ? "/tasks"
            : a.target === "echo-speakers"
              ? "/echo"
              : "/settings",
        );
      else throw new Error("This action is not available on the web yet.");
    } catch (e) {
      setError(e);
    }
  }
  async function feedback(brief: Brief, card: FeedCard, value: string) {
    try {
      await api.mutate(`/today/briefs/${brief.id}/cards/${card.id}/feedback`, {
        action: value,
      });
      await query.refetch();
    } catch (e) {
      setError(e);
    }
  }
  return (
    <Page
      title="A little perspective."
      eyebrow="Your Feed"
      description="Thoughtful suggestions, drawn from your day."
      actions={
        <Button
          label="Feed preferences"
          icon={<SlidersHorizontal />}
          href="/app/settings#feed"
        />
      }
    >
      <HStack className="feed-filter" gap={3} vAlign="end">
        <DateInput
          label="Browse by date"
          placeholder="All dates"
          presentation="native"
          format="date"
          value={date}
          onChange={setDate}
          hasClear
          width="var(--impo-field-min-width)"
        />
      </HStack>
      {!!error && <ErrorNotice error={error} />}
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <ErrorNotice error={query.error} retry={() => void query.refetch()} />
      ) : !query.data.pages.some((p) => p.briefs.length) ? (
        <Empty
          title="Your day has a story."
          body="Your personal Feed will appear here as Impo gets to know you. Set your preferences to make it your own."
        >
          <Button label="Set Feed preferences" href="/app/settings#feed" />
        </Empty>
      ) : (
        query.data.pages
          .flatMap((p) => p.briefs)
          .map((brief) => (
            <VStack key={brief.id} as="section" className="brief" gap={5}>
              <HStack className="brief-masthead" hAlign="between" vAlign="center" gap={3}>
                <VStack className="grow" gap={1}>
                  <p className="eyebrow">
                    {brief.label}
                  </p>
                  <time className="muted" dateTime={brief.localDate}>
                    {new Date(`${brief.localDate}T12:00:00`).toLocaleDateString("en", {
                      month: "short", day: "numeric", year: "numeric",
                    })}
                  </time>
                </VStack>
                <HStack gap={1} className="no-print" vAlign="center">
                  <Button
                    label="Print Feed"
                    isIconOnly
                    icon={<Printer />}
                    tooltip="Print or save as PDF"
                    variant="ghost"
                    onClick={() => window.print()}
                  />
                  <Confirm
                    label="Delete Feed"
                    icon={<Trash2 />}
                    title="Delete this Feed?"
                    description="This Feed will be removed from your history. Its original sources will stay."
                    action={async () => {
                      await api.mutate(
                        `/today/briefs/${brief.id}`,
                        {},
                        "DELETE",
                      );
                      await cache.invalidateQueries({ queryKey: ["feed"] });
                    }}
                  />
                </HStack>
              </HStack>
              <h2>{brief.content?.title || "Your Feed"}</h2>
              {brief.status !== "completed" && (
                <p role="status">
                  {brief.status === "failed"
                    ? "This Feed could not be prepared. A future edition will appear here."
                    : "Your Feed is being prepared…"}
                </p>
              )}
              {brief.content && (
                <>
                  <p className="brief-summary">{brief.content.summary}</p>
                  <VStack className="feed-cards" gap={4}>
                    {brief.content.cards.map((card, index) => (
                      <VStack
                        as="article"
                        key={card.id || index}
                        className={`feed-card ${index === 0 ? "lead-card" : ""}`}
                        padding={6}
                        gap={4}
                      >
                        <p className="eyebrow">{card.eyebrow}</p>
                        <h3>{card.title}</h3>
                        <Markdown text={card.body} />
                        {card.bullets?.length > 0 && (
                          <ul>
                            {card.bullets.map((b, i) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        )}
                        <HStack gap={2} wrap="wrap">
                          {card.action && card.id && (
                            <Button
                              label={card.action.label}
                              variant="primary"
                              icon={<ArrowUpRight />}
                              clickAction={() => action(brief, card)}
                            />
                          )}{" "}
                          {card.links?.map(
                            (link) =>
                              safeHTTPS(link.url) && (
                                <a
                                  key={link.url}
                                  href={safeHTTPS(link.url)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  {link.title} ↗
                                </a>
                              ),
                          )}
                        </HStack>
                        {card.sourceIds?.length > 0 && (
                          <HStack gap={2} wrap="wrap">
                            {card.sourceIds.map((id) => {
                              const s = brief.sources.find((x) => x.id === id);
                              return s ? (
                                <Button
                                  key={id}
                                  label={s.title}
                                  size="sm"
                                  variant="ghost"
                                  clickAction={async () => {
                                    try {
                                      setSource(
                                        await api.get(
                                          `/today/briefs/${brief.id}/sources/${encodeURIComponent(s.recordId)}`,
                                        ),
                                      );
                                    } catch (e) {
                                      setError(e);
                                    }
                                  }}
                                />
                              ) : null;
                            })}
                          </HStack>
                        )}
                        {card.id && card.type === "suggestion" && (
                          <HStack gap={1} className="no-print" wrap="wrap">
                            <Button
                              label="Snooze for a week"
                              variant="ghost"
                              size="sm"
                              clickAction={() =>
                                feedback(brief, card, "snooze")
                              }
                            />
                            <Button
                              label="Less like this"
                              variant="ghost"
                              size="sm"
                              clickAction={() =>
                                feedback(brief, card, "dismiss")
                              }
                            />
                          </HStack>
                        )}
                      </VStack>
                    ))}
                  </VStack>
                </>
              )}
            </VStack>
          ))
      )}
      {query.hasNextPage && (
        <Button
          label="Earlier editions"
          isLoading={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        />
      )}
      <Dialog
        isOpen={!!source}
        onOpenChange={(v) => !v && setSource(null)}
        width={680}
      >
        <DialogHeader
          title={source?.title || "Source"}
          onOpenChange={(v) => !v && setSource(null)}
        />
        <DialogBody>
          {source && (
            <Markdown
              text={source.text || "This source has no text to display."}
            />
          )}
        </DialogBody>
      </Dialog>
    </Page>
  );
}
