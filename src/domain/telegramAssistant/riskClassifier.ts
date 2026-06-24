import type { TelegramTaskRiskAssessment } from "./types.js";

interface RiskRule {
  reason: string;
  englishTokens?: string[];
  englishPhrases?: string[];
  russianTokenStarts?: string[];
  russianExactTokens?: string[];
}

const HIGH_RISK_RULES: RiskRule[] = [
  {
    reason: "auth_security_access",
    englishTokens: [
      "auth",
      "oauth",
      "sso",
      "security",
      "permission",
      "permissions",
      "access",
      "role",
      "roles",
      "secret",
      "secrets",
      "token",
      "tokens",
      "password",
      "passwords",
      "credential",
      "credentials",
      "login",
    ],
    russianTokenStarts: [
      "аутентификац",
      "авторизац",
      "безопасност",
      "доступ",
      "роль",
      "роли",
      "секрет",
      "токен",
      "парол",
    ],
  },
  {
    reason: "payments_billing",
    englishTokens: [
      "payment",
      "payments",
      "billing",
      "invoice",
      "invoices",
      "checkout",
      "subscription",
      "subscriptions",
      "tariff",
      "tariffs",
      "price",
      "prices",
      "pricing",
    ],
    russianTokenStarts: [
      "платеж",
      "платёж",
      "оплат",
      "биллинг",
      "счет",
      "счёт",
      "тариф",
      "подписк",
    ],
  },
  {
    reason: "data_destructive_or_migration",
    englishTokens: [
      "delete",
      "drop",
      "truncate",
      "migration",
      "migrations",
      "migrate",
      "backfill",
      "wipe",
      "purge",
    ],
    englishPhrases: ["move data", "data move"],
    russianTokenStarts: [
      "удали",
      "дроп",
      "транкейт",
      "миграц",
      "очисти",
      "перенос",
      "перемести",
    ],
  },
  {
    reason: "infrastructure_or_deploy",
    englishTokens: [
      "infra",
      "infrastructure",
      "deploy",
      "deployment",
      "ci",
      "cd",
      "docker",
      "kubernetes",
      "k8s",
      "production",
      "prod",
    ],
    russianExactTokens: ["прод"],
    russianTokenStarts: [
      "инфра",
      "депло",
      "задепло",
      "выклад",
      "продакш",
      "докер",
      "кубер",
      "кубернет",
    ],
  },
  {
    reason: "broad_ambiguous_rewrite",
    englishTokens: [
      "rewrite",
      "refactor",
      "rework",
      "redesign",
      "rebuild",
      "overhaul",
    ],
    russianTokenStarts: ["перепис", "рефактор", "передела", "переработа"],
  },
];

const LOW_RISK_RULE: RiskRule = {
  reason: "documentation_or_tests",
  englishTokens: [
    "docs",
    "documentation",
    "readme",
    "comment",
    "comments",
    "test",
    "tests",
    "spec",
    "specs",
    "coverage",
    "copy",
    "typo",
    "typos",
    "label",
    "labels",
  ],
  russianTokenStarts: [
    "документ",
    "ридми",
    "коммент",
    "тест",
    "спек",
    "покрыти",
    "копи",
    "текст",
    "опечат",
    "лейбл",
    "метк",
  ],
};

const tokenize = (text: string): string[] =>
  text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const hasPhrase = (tokens: string[], phrase: string): boolean => {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0 || phraseTokens.length > tokens.length) {
    return false;
  }

  for (let index = 0; index <= tokens.length - phraseTokens.length; index += 1) {
    const matches = phraseTokens.every(
      (token, offset) => tokens[index + offset] === token,
    );
    if (matches) {
      return true;
    }
  }

  return false;
};

const matchesRule = (tokens: string[], rule: RiskRule): boolean => {
  const tokenSet = new Set(tokens);
  return (
    (rule.englishTokens?.some((token) => tokenSet.has(token)) ?? false) ||
    (rule.englishPhrases?.some((phrase) => hasPhrase(tokens, phrase)) ?? false) ||
    (rule.russianExactTokens?.some((token) => tokenSet.has(token)) ?? false) ||
    (rule.russianTokenStarts?.some((stem) =>
      tokens.some((token) => token.startsWith(stem))
    ) ?? false)
  );
};

export const classifyTelegramTaskRisk = (
  text: string,
): TelegramTaskRiskAssessment => {
  const tokens = tokenize(text);
  const highRiskReasons = HIGH_RISK_RULES
    .filter((rule) => matchesRule(tokens, rule))
    .map(({ reason }) => reason);

  if (highRiskReasons.length > 0) {
    return {
      riskLevel: "high",
      reasons: [...new Set(highRiskReasons)],
      requiresOwnerApproval: true,
    };
  }

  if (matchesRule(tokens, LOW_RISK_RULE)) {
    return {
      riskLevel: "low",
      reasons: ["documentation_or_tests"],
      requiresOwnerApproval: false,
    };
  }

  return {
    riskLevel: "medium",
    reasons: ["isolated_feature_or_bugfix"],
    requiresOwnerApproval: false,
  };
};
