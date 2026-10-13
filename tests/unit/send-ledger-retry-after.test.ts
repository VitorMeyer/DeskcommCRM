import { afterEach, describe, expect, it, vi } from "vitest";

import { applySendOutcome } from "@/lib/agent-engine/edge/crm/send-message";
import { sendWithLedger } from "@/lib/agent-engine/edge/crm/send-ledger";
import type { Queryable } from "@/lib/agent-engine/queue/queue";

afterEach(() => vi.useRealTimers());

describe("retry-after da entrega", () => {
  it("leva o horário persistido da mensagem até o resultado queued do ledger", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => "ledger-1"),
      find: vi.fn(async () => null),
      rotate: vi.fn(async () => "ledger-2"),
      message: vi.fn(async () => null),
      update: vi.fn(async () => {}),
    };

    const result = await sendWithLedger(store, {
      tenantId: "org-1",
      leadId: "contact-1",
      jobId: "job-1",
      seq: 1,
      body: "mensagem",
    }, async () => ({
      id: "message-1",
      status: "queued",
      retryAfterAt: "2026-09-28T12:00:30.000Z",
    }));

    expect(result).toEqual({
      kind: "queued",
      idempotencyKey: "ledger-1",
      crmMessageId: "message-1",
      retryAfterMs: 30_000,
    });
  });

  it("preserva queued manual sem pedir reenvio automático", async () => {
    const store: Parameters<typeof sendWithLedger>[0] = {
      create: vi.fn(async () => "ledger-manual"),
      find: vi.fn(async () => null),
      rotate: vi.fn(async () => "ledger-rotated"),
      message: vi.fn(async () => null),
      update: vi.fn(async () => {}),
    };

    const result = await sendWithLedger(store, {
      tenantId: "org-1",
      leadId: "contact-1",
      jobId: "job-manual",
      seq: 1,
      body: "mensagem",
    }, async () => ({ id: "message-manual", status: "queued", retryable: false }));

    expect(result).toMatchObject({ kind: "queued", retryable: false });
  });

  it("reagenda o job pelo prazo solicitado sem consumir tentativa", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ id: "job-1", status: "pending" }],
    }));
    const db = { query } as unknown as Queryable;

    await expect(
      applySendOutcome(
        db,
        { kind: "queued", idempotencyKey: "ledger-1", crmMessageId: "message-1", retryAfterMs: 30_000 },
        { jobId: "job-1", workerId: "worker-1", tenantId: "org-1", leadId: "contact-1" },
        { queuedRetryDelayMs: 300_000 },
      ),
    ).resolves.toMatchObject({ action: "requeued", job: { id: "job-1", status: "pending" } });

    expect(query.mock.calls[0]![1]).toEqual([
      "job-1",
      "worker-1",
      30_000,
      "envio queued — reagendado sem consumir attempts",
      null,
    ]);
    expect(query.mock.calls[0]![0]).toContain("attempts = greatest(attempts - 1, 0)");
  });

  it("mantém o intervalo configurado quando não existe Retry-After", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ id: "job-1", status: "pending" }],
    }));
    await applySendOutcome(
      { query } as unknown as Queryable,
      { kind: "queued", idempotencyKey: "ledger-1", crmMessageId: "message-1" },
      { jobId: "job-1", workerId: "worker-1", tenantId: "org-1", leadId: "contact-1" },
      { queuedRetryDelayMs: 300_000 },
    );
    expect(query.mock.calls[0]![1]?.[2]).toBe(300_000);
  });

  it("mensagem queued que exige ação humana ENCERRA o job — não o deixa nas mãos do worker", async () => {
    // Antes devolvia `none` sem tocar no job. O chamador lança `JobSettledError`
    // supondo que o run já dispôs dele, mas a lease continuava do worker: o
    // `failJob` dele reagendava com backoff e, ao esgotar as tentativas, abria
    // `job_dead` CRÍTICO — o oposto de "sem reenvio automático".
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({
      rows: [{ id: "job-1", status: "failed" }],
    }));
    await expect(
      applySendOutcome(
        { query } as unknown as Queryable,
        { kind: "queued", idempotencyKey: "ledger-1", crmMessageId: "message-1", retryable: false },
        { jobId: "job-1", workerId: "worker-1", tenantId: "org-1", leadId: "contact-1" },
        { queuedRetryDelayMs: 300_000 },
      ),
    ).resolves.toMatchObject({ action: "canceled", job: { id: "job-1", status: "failed" } });

    expect(query).toHaveBeenCalledTimes(1);
    const [sqlText, params] = query.mock.calls[0]!;
    // terminal: `failed`, sem voltar a `pending` e sem devolver a tentativa
    expect(sqlText).toContain("status = 'failed'");
    expect(sqlText).not.toContain("status = 'pending'");
    expect(sqlText).not.toContain("attempts = greatest");
    expect(params?.slice(0, 2)).toEqual(["job-1", "worker-1"]);
  });
});
