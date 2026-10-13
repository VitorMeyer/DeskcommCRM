import type { SupabaseClient } from "@supabase/supabase-js";

import { numeroObservadoDaSessao } from "./numero-observado";

/** O que o transporte respondeu sobre uma sessão pareada, no vocabulário do banco. */
export interface EstadoObservado {
  status: string;
  phoneNumber?: string | null;
  displayName?: string | null;
}

/**
 * Sincroniza o espelho com o que o transporte diz agora.
 *
 * Devolve `phoneConflict` quando o número lido já pertence a OUTRO canal ativo da
 * organização (a trava de número único): o resto do estado é gravado mesmo assim,
 * e o conflito sobe à tela. Descartar o erro deixaria a conexão sem telefone e
 * sem explicação — e é o que acontece a quem troca de transporte mantendo o
 * número, o caso central deste canal.
 */
export async function sincronizarEstadoDaSessaoPareada(
  admin: SupabaseClient,
  session: Record<string, unknown> & { id: string; organization_id: string },
  state: EstadoObservado,
): Promise<{ phoneConflict: boolean }> {
  const statusChanged = session.status !== state.status;
  const gravado = typeof session.phone_number === "string" ? session.phone_number : null;
  // Só um estado `WORKING` observa o aparelho de verdade: desconectada, a API
  // devolve `jid: null`, e gravar isso apagaria o número que dá nome ao aviso da
  // Central ("QUAL conexão caiu?").
  const observado = numeroObservadoDaSessao({
    jid: state.phoneNumber,
    statusAoVivo: state.status,
    gravado,
  });
  const patch: Record<string, unknown> = {};
  if (statusChanged) {
    patch.status = state.status;
    patch.status_reason = null;
    patch.last_status_change_at = new Date().toISOString();
  }
  if (observado !== gravado) patch.phone_number = observado;
  if (state.displayName !== undefined && session.display_name !== state.displayName)
    patch.display_name = state.displayName;
  if (Object.keys(patch).length === 0) return { phoneConflict: false };

  const gravar = (corpo: Record<string, unknown>) =>
    admin
      .from("channel_sessions")
      .update(corpo)
      .eq("organization_id", session.organization_id)
      .eq("id", session.id);

  const { error } = await gravar(patch);
  if (!error) return { phoneConflict: false };
  if (error.code !== "23505" || !("phone_number" in patch)) {
    throw new Error(`channel_session_status_update_failed: ${error.message}`);
  }
  // 23505 aqui só pode ser a trava de número único: regrava sem o telefone, para
  // o estado e o carimbo não ficarem reféns do conflito.
  const { phone_number: _descartado, ...semTelefone } = patch;
  if (Object.keys(semTelefone).length > 0) {
    const { error: retryError } = await gravar(semTelefone);
    if (retryError) {
      throw new Error(`channel_session_status_update_failed: ${retryError.message}`);
    }
  }
  return { phoneConflict: true };
}

