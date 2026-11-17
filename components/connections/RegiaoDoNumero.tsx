"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiClient } from "@/lib/api/client";
import type { CidadeDaRegiao, RegiaoDaConexao } from "@/lib/channels";
import { useT } from "@/hooks/i18n/useT";

interface Estado {
  sigla: string;
  nome: string;
}

/**
 * Região de saída do número hospedado (proxy regional do transporte).
 *
 * O WhatsApp enxerga o número saindo de um IP; perto de onde o negócio atende é
 * o sinal certo. A escolha é estado → cidade, das listas do próprio catálogo do
 * transporte — nunca texto livre, que só falharia no próximo ciclo da conexão.
 */
export function RegiaoDoNumero({ sessionId }: { sessionId: string }) {
  const t = useT();
  const queryClient = useQueryClient();
  const rota = `/api/v1/channels/hosted-session/${sessionId}/regiao`;
  const [estado, setEstado] = useState<string | null>(null);
  const [cidade, setCidade] = useState<string | null>(null);
  const [filtro, setFiltro] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [mensagem, setMensagem] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const geral = useQuery({
    queryKey: ["hosted-region", sessionId],
    queryFn: async () =>
      (await apiClient.get<{ data: { atual: RegiaoDaConexao; estados: Estado[] } }>(rota)).data,
  });
  const atual = geral.data?.atual ?? null;
  // O estado em foco: o escolhido agora, ou o que a conexão já usa.
  const estadoEmFoco = estado ?? atual?.estado ?? null;
  const cidades = useQuery({
    queryKey: ["hosted-region-cities", sessionId, estadoEmFoco],
    queryFn: async () =>
      (await apiClient.get<{ data: { cidades: CidadeDaRegiao[] } }>(`${rota}?estado=${estadoEmFoco}`)).data
        .cidades,
    enabled: Boolean(estadoEmFoco),
  });

  const visiveis = useMemo(() => {
    const termo = filtro.trim().toLowerCase();
    const lista = cidades.data ?? [];
    return termo ? lista.filter((c) => c.nome.toLowerCase().includes(termo)) : lista;
  }, [cidades.data, filtro]);

  const nomeDaCidadeAtual =
    atual?.cidade && atual.estado === estadoEmFoco
      ? (cidades.data?.find((c) => c.valor === atual.cidade)?.nome ?? atual.cidade)
      : atual?.cidade ?? null;

  function descricaoDoAtual(): string {
    if (!atual) return "";
    if (atual.emUso === "contingencia")
      return t("A rota da região caiu e a conexão está usando uma rota de contingência.");
    if (atual.emUso === "propria") return t("A conexão usa um proxy próprio, configurado no painel do serviço.");
    if (atual.emUso === "direta") return t("A conexão sai sem proxy.");
    if (atual.cidade) return `${t("Em uso:")} ${nomeDaCidadeAtual} – ${(atual.estado ?? "").toUpperCase()}`;
    return t("Em uso: Brasil, sem cidade fixa.");
  }

  async function aplicar() {
    if (!estadoEmFoco || !cidade) return;
    setSalvando(true);
    setErro(null);
    setMensagem(null);
    try {
      await apiClient.put(rota, { estado: estadoEmFoco, cidade });
      setMensagem(t("Região salva. Ela passa a valer no próximo ciclo da conexão."));
      await queryClient.invalidateQueries({ queryKey: ["hosted-region", sessionId] });
    } catch (err) {
      setErro(err instanceof Error && err.message ? err.message : t("Não foi possível salvar a região da conexão."));
    } finally {
      setSalvando(false);
    }
  }

  if (geral.isError) {
    return (
      <p className="text-xs text-muted-foreground">{t("Não foi possível consultar a região da conexão.")}</p>
    );
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3" data-testid="regiao-do-numero">
      <div>
        <h4 className="text-sm font-medium">{t("Região do número")}</h4>
        <p className="text-xs text-muted-foreground">
          {t("O WhatsApp vê o número saindo desta cidade. Escolha perto de onde o negócio atende.")}
        </p>
        {atual && <p className="mt-1 text-xs">{descricaoDoAtual()}</p>}
        {atual?.erro && <p className="mt-1 text-xs text-warning-fg">{atual.erro}</p>}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="regiao-estado">{t("Estado")}</Label>
          <Select
            value={estadoEmFoco ?? undefined}
            onValueChange={(v) => {
              setEstado(v);
              setCidade(null);
              setFiltro("");
            }}
            disabled={!geral.data}
          >
            <SelectTrigger id="regiao-estado">
              <SelectValue placeholder={t("Escolha o estado")} />
            </SelectTrigger>
            <SelectContent>
              {(geral.data?.estados ?? []).map((e) => (
                <SelectItem key={e.sigla} value={e.sigla}>
                  {e.nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="regiao-cidade">{t("Cidade")}</Label>
          <Input
            aria-label={t("Filtrar cidades")}
            placeholder={t("Filtrar cidades")}
            value={filtro}
            onChange={(e) => setFiltro(e.target.value)}
            disabled={!estadoEmFoco}
          />
          <Select value={cidade ?? undefined} onValueChange={setCidade} disabled={!estadoEmFoco || !cidades.data}>
            <SelectTrigger id="regiao-cidade">
              <SelectValue placeholder={t("Escolha a cidade")} />
            </SelectTrigger>
            <SelectContent>
              {visiveis.map((c) => (
                <SelectItem key={c.valor} value={c.valor}>
                  {c.nome}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void aplicar()} disabled={salvando || !estadoEmFoco || !cidade}>
          {salvando ? t("Salvando…") : t("Aplicar região")}
        </Button>
        {mensagem && (
          <p role="status" className="text-xs text-success-fg">
            {mensagem}
          </p>
        )}
        {erro && (
          <p role="alert" className="text-xs text-destructive">
            {erro}
          </p>
        )}
      </div>
    </div>
  );
}
