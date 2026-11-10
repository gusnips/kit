# @gusnips/cnpj

Finds a Brazilian company by its CNPJ: its legal name, status, address, activities, partners,
Simples and MEI. It asks public services one after another until one has the company, and every
answer comes back in the same shape. CNPJs with letters work too. It only needs `fetch`, so it runs
in Node, Bun, browsers and Workers.

```ts
import { lookupCnpj } from "@gusnips/cnpj";

const company = await lookupCnpj("33.000.167/0001-01");
company.razao_social; // "PETROLEO BRASILEIRO S A PETROBRAS"
company.situacao_cadastral; // "ATIVA"
```

## Not found, or no answer

`lookupCnpj` returns the company or throws one of three errors:

- `RangeError`: the value is not a valid CNPJ. Nothing is sent.
- `CnpjNotFoundError`: every provider answered that it doesn't have this CNPJ.
- `CnpjUnavailableError`: no provider found it, and at least one failed (a timeout, a rate limit,
  a server error). The company may well exist. The message names each provider's answer, and
  `cause` holds one error per failure.

Keep the last two apart. A form that says "this company doesn't exist" over a dropped connection
sends the reader to retype a CNPJ that was right.

```ts
import { CnpjNotFoundError, lookupCnpj } from "@gusnips/cnpj";

try {
  fill(await lookupCnpj(cnpj));
} catch (error) {
  if (error instanceof RangeError) return t("errors.cnpjInvalid");
  if (error instanceof CnpjNotFoundError) return t("errors.cnpjNotFound");
  return t("errors.cnpjLookupFailed"); // let them fill in the company by hand
}
```

To show "invalid CNPJ" while somebody types, check the field with `isValidCnpj` from
`@gusnips/br`. It's the same check, and it makes no request.

## Providers

With no `providers`, it asks these four, in this order. The two with a limit of 3 a minute go last.

| Provider         | Service          | What its docs said about limits on 2026-10-17 |
| ---------------- | ---------------- | --------------------------------------------- |
| `minhaReceita()` | minhareceita.org | no limit, and no promise it stays up          |
| `brasilApi()`    | BrasilAPI        | no number, but asks you not to crawl it       |
| `cnpjWs()`       | publica.cnpj.ws  | 3 lookups a minute per IP address             |
| `receitaWs()`    | ReceitaWS        | 3 lookups a minute                            |

All four publish Receita Federal's open data, each in its own format. What they leave out:

- ReceitaWS sends no city codes and no partner CPF or CNPJ, so those are `null`. For a branch it
  sent no partners at all, where the others sent the company's. Its free API only answers CNPJs it
  already has stored, and a CNPJ it hasn't stored counts as a failure, not as not found.
- For both companies in this package's tests, the e-mail was `null` on Minha Receita and BrasilAPI,
  and present on cnpj.ws and ReceitaWS.
- None of them says how many branches a company has, so `total_filiais` is `null`.

Pass your own list to change the order or drop one:

```ts
import { brasilApi, lookupCnpj, minhaReceita } from "@gusnips/cnpj";

await lookupCnpj(cnpj, { providers: [minhaReceita(), brasilApi()] });
```

Each provider gets 8 seconds before the next one is asked. Change that with `timeoutMs`. Pass
`signal` to cancel: the call rejects at once with the signal's reason and asks no other provider.
A provider that fails for some other reason in that same moment rejects with its own error, so you
can tell a cancelled lookup from a failed one.
Pass `fetch` to use your own, in tests for example. Nothing is cached, so cache the record yourself
if you look the same CNPJ up often.

## Your own registry

If you keep a copy of Receita's data on your own server, put it first. The public services are then
only asked when your server doesn't have the company or can't answer.

```ts
import { lookupCnpj, minhaReceita, registry } from "@gusnips/cnpj";

await lookupCnpj(cnpj, {
  providers: [
    registry({ url: "https://cnpj.example.com/v1/cnpj", apiKey: process.env.CNPJ_API_KEY }),
    minhaReceita(),
  ],
});
```

Your server has to follow this contract:

- **Request:** `GET {url}/{cnpj}`, where `{cnpj}` is the 14 characters with no dots, slashes or
  dashes, and letters in uppercase: `GET https://cnpj.example.com/v1/cnpj/33000167000101`. When you
  pass `apiKey`, the request sends it in the `X-API-Key` header.
- **200:** the company, as one record in the shape below, as JSON.
- **404:** your server doesn't have this CNPJ. The lookup asks the next provider. If every provider
  says the same, it throws `CnpjNotFoundError`.
- **Anything else** is a failure: a 401, a 5xx, no answer within `timeoutMs`, a body that isn't a
  record, a record for another CNPJ, an empty `razao_social`, or a `situacao_cadastral` outside the
  five below. The lookup asks the next provider. If none of them has the company, it throws
  `CnpjUnavailableError`, never `CnpjNotFoundError`.

The record, for Petrobras, with one secondary activity and one partner kept:

```json
{
  "cnpj": "33000167000101",
  "razao_social": "PETROLEO BRASILEIRO S A PETROBRAS",
  "nome_fantasia": "PETROBRAS - EDISE",
  "matriz_filial": "MATRIZ",
  "situacao_cadastral": "ATIVA",
  "data_situacao_cadastral": "2005-11-03",
  "motivo_situacao_cadastral": null,
  "data_inicio_atividade": "1966-09-28",
  "natureza_juridica": { "codigo": "2038", "descricao": "Sociedade de Economia Mista" },
  "porte": "DEMAIS",
  "capital_social": 205431960490.52,
  "cnae_principal": { "codigo": "0600001", "descricao": "Extração de petróleo e gás natural" },
  "cnaes_secundarios": [
    { "codigo": "1921700", "descricao": "Fabricação de produtos do refino de petróleo" }
  ],
  "endereco": {
    "logradouro": "AVENIDA REPUBLICA DO CHILE",
    "numero": "65",
    "complemento": null,
    "bairro": "CENTRO",
    "cep": "20031170",
    "uf": "RJ",
    "municipio": { "nome": "Rio de Janeiro", "codigo": "6001", "codigo_ibge": "3304557" }
  },
  "telefones": ["552121660000"],
  "email": "cc-rfisc@petrobras.com.br",
  "socios": [
    {
      "nome": "CLARICE COPPETTI",
      "tipo": "pessoa_fisica",
      "cpf_cnpj": "***995240**",
      "qualificacao": { "codigo": "10", "descricao": "Diretor" },
      "data_entrada": "2023-04-17",
      "faixa_etaria": "61 a 70 anos"
    }
  ],
  "simples_nacional": { "optante": false, "data_opcao": null, "data_exclusao": null },
  "mei": { "optante": false, "data_opcao": null, "data_exclusao": null },
  "total_filiais": null
}
```

How to write each value:

- `cnpj` is the CNPJ that was asked for, in the same 14 characters.
- `situacao_cadastral` is one of `ATIVA`, `BAIXADA`, `INAPTA`, `SUSPENSA` or `NULA`.
- `matriz_filial` is `MATRIZ` or `FILIAL`. `porte` is `MICRO EMPRESA`, `EMPRESA DE PEQUENO PORTE` or
  `DEMAIS`.
- Codes are strings that keep their leading zeros: a CNAE has 7 digits, `natureza_juridica` 4, a
  partner's `qualificacao` 2, the city's `codigo` 4 (Receita's own code) and `codigo_ibge` 7. A CEP
  has 8 digits.
- Dates are `YYYY-MM-DD`. `capital_social` is a number, in reais.
- A phone is `55`, the area code, then the number, digits only.
- A partner's `tipo` is `pessoa_juridica`, `pessoa_fisica` or `estrangeiro`. A person's CPF stays
  masked the way Receita publishes it.
- `motivo_situacao_cadastral` is `null` when Receita gives no reason ("SEM MOTIVO").
- `simples_nacional` and `mei` are `{ "optante": false, ... }` for a company that never opted in.
- `total_filiais` counts the company's branches other than this establishment and its head office:
  a head office with 3 branches has 3, and each of those branches has 2.
- A value you don't have is `null`, and a list you don't have is `[]`.

Your answer is read with the same rules as the public ones, so a CNAE written `06.00-0-01` or a
date written `28/09/1966` still comes out right. Send the shape above anyway: it's the one the
types promise.

To ask something that doesn't follow this contract, write a `CnpjProvider`: a `name` and a
`lookup(cnpj, { signal, fetch })` that resolves the record, resolves `null` for "not found", and
throws for anything else.

## Not here

- **A cache.** Every call asks again. Keep the record yourself if you need it twice.
- **Waiting out a rate limit.** A provider that answers 429 counts as a failure, and the lookup
  moves on to the next one.
- **Error messages.** The errors are for your code, and their messages are in English. The sentence
  the reader sees belongs in your own translations.
