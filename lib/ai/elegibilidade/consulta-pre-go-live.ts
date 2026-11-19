import type { SupabaseClient } from "@supabase/supabase-js";

import { contatoPodeTestar, preGoLiveAtivo } from "./pre-go-live";
import { grupoLiberaIa } from "@/lib/grupos/ia-no-grupo";

export type DecisaoPreGoLive =
  | { ativo: false; permite: true; motivo: "fora_do_pre_go_live" }
  | { ativo: true; permite: true; motivo: "numero_de_teste" }
  | { ativo: true; permite: true; motivo: "grupo_liberado" }
  | { ativo: true; permite: false; motivo: "fora_da_lista_de_teste" };

/**
 * Guarda para caminhos proativos que ainda não têm conversa. O gate normal
 * decide sobre uma conversa; uma automação de primeiro contato precisa fazer
 * esta checagem ANTES de gastar tokens e antes de criar o thread.
 */
export async function decidirPreGoLiveDoCanalViaSupabase(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    contactPhoneNumber: string;
    /**
     * `contacts.social_identity` do destinatário. Opcional: quem não tem (o
     * primeiro contato por telefone) falha fechado na lista social.
     */
    contactSocialIdentity?: string | null;
    /**
     * O `group_chat_id` quando o destino é uma conversa de GRUPO. A chave da IA
     * ligada naquele grupo autoriza no modo de teste (a mesma régua de
     * `decidirElegibilidade`, seção "O grupo" de `./gate.ts`). Ausente = destino
     * individual.
     */
    groupChatId?: string | null;
  },
): Promise<DecisaoPreGoLive> {
  const { data, error } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", input.organizationId)
    .eq("id", input.channelSessionId)
    .maybeSingle();

  if (error) throw new Error(`pre-go-live: leitura do canal falhou — ${error.message}`);
  if (!data) throw new Error("pre-go-live: canal não encontrado");

  const metadata = (data as { metadata: unknown }).metadata;
  if (!preGoLiveAtivo(metadata)) {
    return { ativo: false, permite: true, motivo: "fora_do_pre_go_live" };
  }
  if (input.groupChatId) {
    const grupo = await admin
      .from("channel_session_groups")
      .select("ia_responde")
      .eq("organization_id", input.organizationId)
      .eq("channel_session_id", input.channelSessionId)
      .eq("group_chat_id", input.groupChatId)
      .maybeSingle();
    if (grupo.error) throw new Error(`pre-go-live: leitura do grupo falhou — ${grupo.error.message}`);
    if (grupoLiberaIa((grupo.data as { ia_responde?: unknown } | null)?.ia_responde)) {
      return { ativo: true, permite: true, motivo: "grupo_liberado" };
    }
  }
  return contatoPodeTestar(
    { telefone: input.contactPhoneNumber, identidadeSocial: input.contactSocialIdentity },
    metadata,
  )
    ? { ativo: true, permite: true, motivo: "numero_de_teste" }
    : { ativo: true, permite: false, motivo: "fora_da_lista_de_teste" };
}
