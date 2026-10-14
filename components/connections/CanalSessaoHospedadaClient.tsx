"use client";

import { useState } from "react";
import Image from "next/image";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { lerEstadoDoCanal, nomeDoCanal } from "@/lib/channels/estado";
import { useT } from "@/hooks/i18n/useT";
import { ChannelAiAccess } from "./ChannelAiAccess";
import { ExcluirCanalDialog } from "./ConnectionsClient";
import { PairingOptions } from "./PairingOptions";

interface Sessao {
  id: string;
  instanceId: string;
  serverUrl: string;
  phoneNumber: string | null;
  displayName: string | null;
  status: string;
  hasToken: boolean;
  webhookUrl: string | null;
  archivedAt: string | null;
}

interface EstadoPareamento {
  status: string;
  qrCode: string | null;
  pairingCode: string | null;
  phoneNumber: string | null;
  displayName: string | null;
  /** O número lido já pertence a outro canal ATIVO desta organização. */
  phone_number_conflict?: boolean;
  /** O servidor recusou o token gravado: não há QR nem estado a consultar com ele. */
  credential_rejected?: boolean;
}

const ROTA = "/api/v1/channels/hosted-session";

function imagemDoQr(valor: string | null): string | null {
  if (!valor) return null;
  if (valor.startsWith("data:") || /^https:\/\//i.test(valor)) return valor;
  return `data:image/png;base64,${valor}`;
}

export function CanalSessaoHospedadaClient({ label }: { label: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  // `null` = ainda não editado: o campo mostra a URL gravada, e trocar o token
  // pede só o token novo.
  const [serverUrlEditada, setServerUrl] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [removendo, setRemovendo] = useState(false);

  const { data: session = null, refetch } = useQuery({
    queryKey: ["hosted-channel-session"],
    queryFn: async () =>
      (await apiClient.get<{ data: { session: Sessao | null } }>(ROTA)).data.session,
  });
  const { data: state, refetch: refreshState } = useQuery({
    queryKey: ["hosted-channel-session-state", session?.id],
    queryFn: async () =>
      (await apiClient.get<{ data: EstadoPareamento }>(`${ROTA}/${session!.id}`)).data,
    enabled: Boolean(session?.id),
    // Token recusado não melhora sozinho: consultar a cada 5 s só acumularia erro.
    refetchInterval: (query) =>
      session?.status === "WORKING" || query.state.data?.credential_rejected ? false : 5000,
  });

  const serverUrl = serverUrlEditada ?? session?.serverUrl ?? "";

  async function conectar() {
    setBusy(true);
    setStatusMessage(null);
    setErro(null);
    try {
      await apiClient.post<{ data: { session: Sessao } }>(ROTA, {
        server_url: serverUrl,
        token,
      });
      setToken("");
      setStatusMessage(t("Servidor validado e conexão salva."));
      await Promise.all([
        refetch(),
        refreshState(),
        queryClient.invalidateQueries({ queryKey: ["channel-sessions"] }),
      ]);
      toast.success(t("Conexão salva."));
    } catch (error) {
      setErro(error instanceof Error ? t(error.message) : t("Não foi possível conectar."));
    } finally {
      setBusy(false);
    }
  }

  async function executar(action: "connect" | "disconnect") {
    if (!session) return;
    setBusy(true);
    setErro(null);
    try {
      await apiClient.post(`${ROTA}/${session.id}`, { action });
      toast.success(
        action === "disconnect" ? t("Número desconectado.") : t("Estado da conexão atualizado."),
      );
    } catch (error) {
      setErro(
        error instanceof Error ? t(error.message) : t("Não foi possível concluir a operação."),
      );
    } finally {
      await Promise.all([
        refreshState(),
        refetch(),
        queryClient.invalidateQueries({ queryKey: ["channel-sessions"] }),
      ]);
      setBusy(false);
    }
  }

  async function removida() {
    setRemovendo(false);
    setServerUrl(null);
    setToken("");
    setStatusMessage(null);
    setErro(null);
    await Promise.all([
      refetch(),
      queryClient.invalidateQueries({ queryKey: ["channel-sessions"] }),
    ]);
  }

  const qr = imagemDoQr(state?.qrCode ?? null);
  const status = state?.status ?? session?.status ?? "STOPPED";
  const statusInfo = lerEstadoDoCanal(status);
  const credencialRecusada = Boolean(state?.credential_rejected);

  return (
    <div className="flex flex-col gap-4" data-testid="canal-sessao-hospedada">
      <Card className="flex flex-col gap-4 p-4">
        <div>
          <h3 className="text-sm font-semibold">
            {t("Conectar por")} {label}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(
              "Cole a URL e o token de uma instância já criada no painel do serviço. O token é validado antes de ser cifrado e salvo nesta organização.",
            )}
          </p>
        </div>

        {session && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">
                {nomeDoCanal(
                  { display_name: session.displayName, phone_number: session.phoneNumber },
                  t,
                )}
              </p>
              <Badge variant={statusInfo.tom === "success" ? "secondary" : "outline"}>
                {t(statusInfo.rotulo)}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              {session.phoneNumber ?? t("Número ainda não pareado")}
            </p>
          </div>
        )}

        {credencialRecusada && (
          <p role="alert" className="text-sm text-warning-fg">
            {t(
              "O servidor recusou o token salvo. Cole o token de uma instância válida para trocar, ou remova a conexão.",
            )}
          </p>
        )}

        {session && <ChannelAiAccess channelId={session.id} />}

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hosted-server-url">{t("URL do servidor")}</Label>
          <Input
            id="hosted-server-url"
            type="url"
            autoComplete="url"
            placeholder="https://servidor.example.com"
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="hosted-instance-token">{t("Token da instância")}</Label>
          <Input
            id="hosted-instance-token"
            type="password"
            autoComplete="off"
            placeholder={session?.hasToken ? t("Cole o token novo para trocar") : t("Cole o token")}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
          {session && (
            <p className="text-xs text-muted-foreground">
              {t(
                "Pode ser o token de outra instância. Com o número conectado, desconecte-o antes de trocar.",
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={conectar} disabled={busy || !serverUrl.trim() || !token.trim()}>
            {busy ? t("Verificando…") : session ? t("Trocar token") : t("Validar e conectar")}
          </Button>
          {session && status !== "WORKING" && !credencialRecusada && (
            <Button variant="outline" onClick={() => void executar("connect")} disabled={busy}>
              {t("Gerar QR Code")}
            </Button>
          )}
          {session && status === "WORKING" && (
            <Button variant="outline" onClick={() => void executar("disconnect")} disabled={busy}>
              {t("Desconectar")}
            </Button>
          )}
          {session && (
            <Button variant="ghost" onClick={() => setRemovendo(true)} disabled={busy}>
              {t("Remover conexão")}
            </Button>
          )}
        </div>
        {statusMessage && (
          <p role="status" className="text-sm text-success-fg">
            {statusMessage}
          </p>
        )}
        {erro && (
          <p role="alert" className="text-sm text-destructive">
            {erro}
          </p>
        )}
        {state?.phone_number_conflict && (
          <p role="alert" className="text-sm text-warning-fg">
            {t(
              "Este número já está conectado em outro canal ativo desta organização. Remova o outro canal para usá-lo aqui.",
            )}
          </p>
        )}
        {session?.id && status !== "WORKING" && !credencialRecusada && (
          <div className="rounded-md border p-3">
            <PairingOptions
              sessionId={session.id}
              pairingCodeUrl={`${ROTA}/${session.id}`}
              qr={
                qr ? (
                  <Image
                    src={qr}
                    alt={t("QR Code para conectar o WhatsApp")}
                    width={256}
                    height={256}
                    unoptimized
                    className="h-64 w-64 object-contain"
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("Gere o QR Code para iniciar o pareamento.")}
                  </p>
                )
              }
            />
          </div>
        )}
      </Card>

      {removendo && session && (
        <ExcluirCanalDialog
          canal={{
            id: session.id,
            display_name: session.displayName,
            phone_number: session.phoneNumber,
          }}
          onCancel={() => setRemovendo(false)}
          onDeleted={() => void removida()}
        />
      )}
    </div>
  );
}
