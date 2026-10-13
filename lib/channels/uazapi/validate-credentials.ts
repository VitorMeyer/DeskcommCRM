import { validarUazapiServerUrl } from "./credentials";
import { estadoDoCanalUazapi } from "./estado";

export type ValidacaoUazapi =
  | {
      ok: true;
      serverUrl: string;
      instanceId: string;
      status: string;
      phoneNumber: string | null;
      displayName: string | null;
    }
  | { ok: false; motivo: string };

function texto(valor: unknown): string | null {
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

/** Valida URL e token com a leitura de status antes de persistir qualquer segredo. */
export async function validarCredenciaisUazapi(input: {
  serverUrl: string;
  token: string;
}): Promise<ValidacaoUazapi> {
  const token = input.token.trim();
  if (!token) return { ok: false, motivo: "Informe o token da instância." };

  let serverUrl: string;
  try {
    serverUrl = await validarUazapiServerUrl(input.serverUrl);
  } catch (error) {
    const code = error instanceof Error ? error.message : "unsafe_url:invalid";
    return {
      ok: false,
      motivo: code.startsWith("unsafe_url:")
        ? "A URL informada não é um endereço HTTPS público válido."
        : "Não foi possível validar o endereço informado.",
    };
  }

  let response: Response;
  try {
    response = await fetch(`${serverUrl}/instance/status`, {
      redirect: "error",
      headers: { token },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return {
      ok: false,
      motivo: "Não foi possível falar com o servidor. Verifique a URL e tente de novo.",
    };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, motivo: "Token recusado pelo servidor." };
  }
  if (!response.ok) return { ok: false, motivo: `O servidor respondeu ${response.status}.` };

  const body = (await response.json().catch(() => null)) as {
    instance?: { id?: unknown; status?: unknown; profileName?: unknown };
    status?: { connected?: unknown; loggedIn?: unknown; jid?: { user?: unknown } | null };
  } | null;
  const instanceId = texto(body?.instance?.id);
  if (!instanceId) return { ok: false, motivo: "O token não identificou uma instância válida." };

  const status =
    estadoDoCanalUazapi(
      body?.instance?.status,
      body?.status?.connected === true || body?.status?.loggedIn === true,
    ) ?? "FAILED";

  return {
    ok: true,
    serverUrl,
    instanceId,
    status,
    phoneNumber: texto(body?.status?.jid?.user)?.replace(/\D/g, "") ?? null,
    displayName: texto(body?.instance?.profileName),
  };
}
