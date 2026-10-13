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
import { PairingOptions } from "./PairingOptions";

interface Sessao {
  id: string;
  instanceId: string;
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
  const [serverUrl, setServerUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

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
    refetchInterval: session?.status === "WORKING" ? false : 5000,
  });

  async function conectar() {
    setBusy(true);
    setStatusMessage(null);
    try {
      const result = await apiClient.post<{ data: { session: Sessao } }>(ROTA, {
        server_url: serverUrl,
        token,
      });
      setToken("");
      setStatusMessage(t("Servidor validado e conexão salva."));
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ["channel-sessions"] });
      toast.success(t("Conexão salva."));
      void result;
    } catch (error) {
      toast.error(error instanceof Error ? t(error.message) : t("Não foi possível conectar."));
    } finally {
      setBusy(false);
    }
  }

  async function executar(action: "connect" | "disconnect" | "delete") {
    if (!session) return;
    setBusy(true);
    try {
      await apiClient.post(`${ROTA}/${session.id}`, { action });
      await Promise.all([
        refreshState(),
        refetch(),
        queryClient.invalidateQueries({ queryKey: ["channel-sessions"] }),
      ]);
      toast.success(
        action === "disconnect" ? t("Número desconectado.") : t("Estado da conexão atualizado."),
      );
    } catch (error) {
      toast.error(
        error instanceof Error ? t(error.message) : t("Não foi possível concluir a operação."),
      );
    } finally {
      setBusy(false);
    }
  }

  const qr = imagemDoQr(state?.qrCode ?? null);
  const status = state?.status ?? session?.status ?? "STOPPED";
  const statusInfo = lerEstadoDoCanal(status);

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
            placeholder={
              session?.hasToken ? t("gravado — preencha para atualizar") : t("Cole o token")
            }
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={conectar} disabled={busy || !serverUrl.trim() || !token.trim()}>
            {busy ? t("Verificando…") : session ? t("Atualizar conexão") : t("Validar e conectar")}
          </Button>
          {session && status !== "WORKING" && (
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
            <Button variant="ghost" onClick={() => void executar("delete")} disabled={busy}>
              {t("Remover conexão")}
            </Button>
          )}
        </div>
        {statusMessage && (
          <p role="status" className="text-sm text-success-fg">
            {statusMessage}
          </p>
        )}
        {state?.phone_number_conflict && (
          <p role="alert" className="text-sm text-warning-fg">
            {t(
              "Este número já está conectado em outro canal ativo desta organização. Remova o outro canal para usá-lo aqui.",
            )}
          </p>
        )}
        {session?.id && status !== "WORKING" && (
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
    </div>
  );
}
