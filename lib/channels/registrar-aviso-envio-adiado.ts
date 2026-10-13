import type { SupabaseClient } from "@supabase/supabase-js";

import type { ChannelAdapter } from "./types";

type AvisoOperacional = NonNullable<
  NonNullable<ChannelAdapter["deferredErrors"]>[number]["operatorNotice"]
>;

/** Abre um único aviso por conexão enquanto houver um bloqueio manual aberto. */
export async function registrarAvisoDeEnvioAdiado(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    aviso: AvisoOperacional;
  },
): Promise<"criado" | "ja_aberto"> {
  const { organizationId, channelSessionId, aviso } = input;

  const { data: existente, error: erroLeitura } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("kind", aviso.kind)
    .eq("title", aviso.title)
    .eq("ref_kind", "channel_session")
    .eq("ref_id", channelSessionId)
    .eq("status", "open")
    .limit(1)
    .maybeSingle();
  if (erroLeitura) throw new Error("channel_deferred_notice_lookup_failed");
  if (existente) return "ja_aberto";

  const { error: erroInsert } = await admin.from("agent_inbox_items").insert({
    organization_id: organizationId,
    kind: aviso.kind,
    severity: aviso.severity,
    title: aviso.title,
    body: aviso.body,
    ref_kind: "channel_session",
    ref_id: channelSessionId,
  });
  if (erroInsert) throw new Error("channel_deferred_notice_insert_failed");
  return "criado";
}
