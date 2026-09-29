import type { AgentItem } from './gateway.js';

/**
 * Intermediate progress of a running Turn, streamed live and never stored: commands in the
 * Sandbox, web searches, other tools, reasoning summaries and interim commentary. History
 * (Rebyte /history) carries only the user's input and the final answer.
 */
export interface StepData {
  schemaVersion: 1;
  kind: 'command' | 'search' | 'tool' | 'reasoning' | 'note';
  title: string;
  detail?: string;
  /** Why a step failed: exit code and the tail of its output. */
  result?: string;
  status: 'in_progress' | 'completed' | 'failed';
}

const clip = (text: string, limit: number) => (text.length > limit ? `${text.slice(0, limit - 1)}…` : text);
const tail = (text: string, limit: number) => (text.length > limit ? `…${text.slice(text.length - limit + 1)}` : text);
const firstLine = (text: string) => text.split('\n').find(line => line.trim())?.trim() ?? '';
function status(value: unknown): StepData['status'] {
  return value === 'completed' ? 'completed' : value === 'failed' || value === 'incomplete' ? 'failed' : 'in_progress';
}

/**
 * Steps of one Turn in stream order. `ownTool` names are skipped: Instant's own functions
 * (device, Gmail, tasks) already stream as tool parts with their receipts.
 */
export function turnSteps(items: AgentItem[], turnId: string, ownTool: (name: string) => boolean): Array<{ id: string; data: StepData }> {
  const steps: Array<{ id: string; data: StepData }> = [];
  for (const item of items) {
    if (item.turn_id !== turnId || !item.id) continue;
    const value = item as unknown as Record<string, unknown>;
    if (item.type === 'command_execution') {
      const exit = typeof value.exit_code === 'number' ? value.exit_code : null;
      const done = status(value.status);
      const failed = done === 'failed' || (done === 'completed' && exit !== null && exit !== 0);
      // A failure carries its reason: the exit code and the last lines of output.
      const output = typeof value.output === 'string' ? value.output.trimEnd().split('\n').slice(-4).join('\n') : '';
      const result = failed ? [exit !== null ? `exit ${exit}` : '', output ? tail(output, 400) : ''].filter(Boolean).join('\n') : '';
      steps.push({ id: item.id, data: { schemaVersion: 1, kind: 'command', title: 'Run command', detail: clip(firstLine(String(value.command ?? '')), 160),
        ...(result ? { result } : {}), status: failed ? 'failed' : done } });
    } else if (item.type === 'web_search_call') {
      const action = (value.action ?? {}) as Record<string, unknown>;
      const query = typeof action.query === 'string' ? action.query : Array.isArray(action.queries) ? action.queries.join(', ') : typeof action.url === 'string' ? action.url : '';
      steps.push({ id: item.id, data: { schemaVersion: 1, kind: 'search', title: 'Search the web', ...(query ? { detail: clip(query, 160) } : {}), status: status(value.status) } });
    } else if (item.type === 'function_call' || item.type === 'mcp_call') {
      const name = String(value.name ?? '');
      if (!name || (item.type === 'function_call' && ownTool(name))) continue;
      const label = item.type === 'mcp_call' && typeof value.server_label === 'string' ? `${value.server_label}.${name}` : name;
      steps.push({ id: item.id, data: { schemaVersion: 1, kind: 'tool', title: 'Use tool', detail: clip(label, 80), status: status(value.status) } });
    } else if (item.type === 'reasoning') {
      const summary = Array.isArray(value.summary) ? (value.summary as Array<{ text?: string }>).map(part => part.text ?? '').join(' ').trim() : '';
      if (summary) steps.push({ id: item.id, data: { schemaVersion: 1, kind: 'reasoning', title: 'Thinking', detail: clip(summary, 240), status: status(value.status ?? 'completed') } });
    } else if (item.type === 'message' && item.role === 'assistant' && value.phase === 'commentary') {
      const text = item.content.map(part => (part.type === 'output_text' ? part.text : '')).join('').trim();
      if (text) steps.push({ id: item.id, data: { schemaVersion: 1, kind: 'note', title: 'Update', detail: clip(text, 240), status: status(value.status) } });
    }
  }
  return steps;
}
