export const sanitizeRepositoryKey = (repositoryName: string): string => {
  const key = repositoryName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return key || "repository";
};
