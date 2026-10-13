import { describe, expect, it } from "vitest";

import { estadoDoCanalUazapi } from "@/lib/channels/uazapi/estado";

/**
 * Uma tabela só para o estado remoto. O webhook de conexão, a leitura de status
 * e a validação da credencial recebem o MESMO estado; três cópias divergem na
 * primeira vez que a API ganhar um.
 */
describe("estadoDoCanalUazapi", () => {
  it.each([
    ["connected", "WORKING"],
    ["connecting", "SCAN_QR_CODE"],
    ["registering", "STARTING"],
    ["disconnected", "STOPPED"],
    ["hibernated", "STOPPED"],
    ["registration_conflict", "FAILED"],
  ] as const)("%s vira %s", (remoto, esperado) => {
    expect(estadoDoCanalUazapi(remoto)).toBe(esperado);
  });

  it("ignora caixa e espaços", () => {
    expect(estadoDoCanalUazapi("  Connected ")).toBe("WORKING");
  });

  it("o booleano `connected`/`loggedIn` vale mais que o texto", () => {
    expect(estadoDoCanalUazapi("disconnected", true)).toBe("WORKING");
  });

  it("estado que a API inventar amanhã é `null` — quem chama decide, o helper não chuta", () => {
    expect(estadoDoCanalUazapi("algo_novo")).toBeNull();
    expect(estadoDoCanalUazapi(undefined)).toBeNull();
    expect(estadoDoCanalUazapi(42)).toBeNull();
  });

  it("`FAILED` nunca sai de um estado vivo: hibernada é STOPPED, não falha", () => {
    // FAILED é o que o vigia trata como "pode ser banimento — não religue".
    expect(estadoDoCanalUazapi("hibernated")).not.toBe("FAILED");
    expect(estadoDoCanalUazapi("disconnected")).not.toBe("FAILED");
  });
});
