import type { TelegramTaskRiskAssessment } from "./types.js";

const HIGH_RISK_PATTERNS: Array<{
  reason: string;
  pattern: RegExp;
}> = [
  {
    reason: "auth_security_access",
    pattern: /\b(auth|oauth|sso|security|permission|access|role|roles|secret|token|password|credential|login)\b|аутентификац|авторизац|безопасност|доступ|роль|роли|секрет|токен|парол/u,
  },
  {
    reason: "payments_billing",
    pattern: /\b(payment|payments|billing|invoice|checkout|subscription|tariff|price|pricing)\b|плат[её]ж|оплат|биллинг|сч[её]т|тариф|подписк/u,
  },
  {
    reason: "data_destructive_or_migration",
    pattern: /\b(delete|drop|truncate|migration|migrate|move data|data move|backfill|wipe|purge)\b|удали|удалить|дроп|транкейт|миграц|перенос\s+данн|перемести\s+данн|очисти|очистить/u,
  },
  {
    reason: "infrastructure_or_deploy",
    pattern: /\b(infra|infrastructure|deploy|deployment|ci|cd|docker|kubernetes|k8s|production|prod)\b|инфра|депло|выклад|прод\b|продакш|докер|кубер|кубернет/u,
  },
  {
    reason: "broad_ambiguous_rewrite",
    pattern: /\b(rewrite|refactor|rework|redesign|rebuild|overhaul)\b|перепис|рефактор|передела|переработа/u,
  },
];

const LOW_RISK_PATTERN =
  /\b(docs|documentation|readme|comment|comments|test|tests|spec|coverage|copy|typo|typos|label|labels)\b|документ|ридми|коммент|тест|спек|покрыти|копи|текст|опечат|лейбл|метк/u;

export const classifyTelegramTaskRisk = (
  text: string,
): TelegramTaskRiskAssessment => {
  const normalizedText = text.trim().toLowerCase();
  const highRiskReasons = HIGH_RISK_PATTERNS
    .filter(({ pattern }) => pattern.test(normalizedText))
    .map(({ reason }) => reason);

  if (highRiskReasons.length > 0) {
    return {
      riskLevel: "high",
      reasons: [...new Set(highRiskReasons)],
      requiresOwnerApproval: true,
    };
  }

  if (LOW_RISK_PATTERN.test(normalizedText)) {
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
